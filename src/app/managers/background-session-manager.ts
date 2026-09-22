import type { Event, Message, Session } from "@opencode-ai/sdk/v2";
import { isScheduledTaskSessionIgnored } from "../services/scheduled-task-session-ignore-service.js";
import { logger } from "../../utils/logger.js";

export type BackgroundSessionNotificationKind =
  | "assistant_response"
  | "question_asked"
  | "permission_asked";

export interface BackgroundSessionNotification {
  kind: BackgroundSessionNotificationKind;
  sessionId: string;
  sessionTitle?: string | undefined;
  requestId?: string | undefined;
  messageId?: string | undefined;
}

type NotificationCallback = (notification: BackgroundSessionNotification) => void | Promise<void>;

interface PendingAssistantResponse {
  messageId: string;
}

class BackgroundSessionTracker {
  // Dedup structures must stay bounded: a long-lived same-directory bot would
  // otherwise accumulate entries forever (Sets/Maps only clear on directory switch).
  private static readonly MAX_TRACKED_IDS = 1000;
  private static readonly MAX_PENDING_RESPONSES = 500;

  private directory: string | null = null;
  private onNotification: NotificationCallback | null = null;
  private sessionTitles = new Map<string, string>();
  private childSessionIds = new Set<string>();
  private mutedSessionIds = new Set<string>();
  private completedAssistantMessageIds = new Set<string>();
  private pendingAssistantResponsesBySessionId = new Map<string, PendingAssistantResponse>();
  private questionRequestIds = new Set<string>();
  private permissionRequestIds = new Set<string>();

  setDirectory(directory: string): void {
    if (this.directory === directory) {
      return;
    }

    this.clear();
    this.directory = directory;
  }

  setOnNotification(callback: NotificationCallback): void {
    this.onNotification = callback;
  }

  /**
   * Excludes a session from background notifications (e.g. the dedicated
   * inline session, whose results are delivered in place).
   */
  setMuted(sessionId: string, muted: boolean): void {
    if (!sessionId) {
      return;
    }
    if (muted) {
      this.trackId(this.mutedSessionIds, sessionId);
    } else {
      this.mutedSessionIds.delete(sessionId);
    }
  }

  clear(): void {
    this.directory = null;
    this.sessionTitles.clear();
    this.childSessionIds.clear();
    this.mutedSessionIds.clear();
    this.completedAssistantMessageIds.clear();
    this.pendingAssistantResponsesBySessionId.clear();
    this.questionRequestIds.clear();
    this.permissionRequestIds.clear();
  }

  processEvent(event: Event, currentSessionId: string | null): void {
    switch (event.type) {
      case "session.created":
      case "session.updated":
        this.handleSessionInfo(event.properties);
        break;
      case "message.updated":
        this.handleMessageUpdated(event.properties, currentSessionId);
        break;
      case "session.idle":
        this.handleSessionIdle(event.properties, currentSessionId);
        break;
      case "question.asked":
        this.handleRequestEvent("question_asked", event.properties, currentSessionId);
        break;
      case "permission.asked":
        this.handleRequestEvent("permission_asked", event.properties, currentSessionId);
        break;
      default:
        break;
    }
  }

  private handleSessionInfo(properties: { info: Session }): void {
    const info = properties.info;
    if (!info?.id) {
      return;
    }

    const title = info.title?.trim();
    if (title) {
      this.sessionTitles.set(info.id, title);
      if (this.sessionTitles.size > BackgroundSessionTracker.MAX_TRACKED_IDS) {
        const oldest = this.sessionTitles.keys().next().value;
        if (oldest !== undefined) {
          this.sessionTitles.delete(oldest);
        }
      }
    }

    if (info.parentID) {
      this.trackId(this.childSessionIds, info.id);
    }
  }

  private handleMessageUpdated(
    properties: { info: Message },
    currentSessionId: string | null,
  ): void {
    const info = properties.info;
    const sessionId = info?.sessionID;
    const messageId = info?.id;
    if (!sessionId || !messageId || info?.role !== "assistant" || !info.time?.completed) {
      return;
    }

    if (this.shouldIgnoreSession(sessionId, currentSessionId)) {
      return;
    }

    if (this.completedAssistantMessageIds.has(messageId)) {
      return;
    }

    this.trackId(this.completedAssistantMessageIds, messageId);
    this.trackPendingResponse(sessionId, messageId);
  }

  private handleSessionIdle(
    properties: { sessionID: string },
    currentSessionId: string | null,
  ): void {
    const sessionId = properties.sessionID;
    if (!sessionId || this.shouldIgnoreSession(sessionId, currentSessionId)) {
      return;
    }

    const pendingResponse = this.pendingAssistantResponsesBySessionId.get(sessionId);
    if (!pendingResponse) {
      return;
    }

    this.pendingAssistantResponsesBySessionId.delete(sessionId);
    this.emitNotification({
      kind: "assistant_response",
      sessionId,
      sessionTitle: this.sessionTitles.get(sessionId),
      messageId: pendingResponse.messageId,
    });
  }

  private handleRequestEvent(
    kind: Extract<BackgroundSessionNotificationKind, "question_asked" | "permission_asked">,
    properties: { id: string; sessionID: string },
    currentSessionId: string | null,
  ): void {
    const { id, sessionID: sessionId } = properties;
    if (!id || !sessionId) {
      return;
    }

    if (this.shouldIgnoreSession(sessionId, currentSessionId)) {
      return;
    }

    const deliveredRequestIds =
      kind === "question_asked" ? this.questionRequestIds : this.permissionRequestIds;
    if (deliveredRequestIds.has(id)) {
      return;
    }

    deliveredRequestIds.add(id);
    this.trimIdSet(deliveredRequestIds);
    this.emitNotification({
      kind,
      sessionId,
      sessionTitle: this.sessionTitles.get(sessionId),
      requestId: id,
    });
  }

  private trackId(set: Set<string>, id: string): void {
    set.add(id);
    this.trimIdSet(set);
  }

  private trimIdSet(set: Set<string>): void {
    while (set.size > BackgroundSessionTracker.MAX_TRACKED_IDS) {
      const oldest = set.values().next().value;
      if (oldest === undefined) {
        break;
      }
      set.delete(oldest);
    }
  }

  private trackPendingResponse(sessionId: string, messageId: string): void {
    this.pendingAssistantResponsesBySessionId.set(sessionId, { messageId });
    while (
      this.pendingAssistantResponsesBySessionId.size >
      BackgroundSessionTracker.MAX_PENDING_RESPONSES
    ) {
      const oldest = this.pendingAssistantResponsesBySessionId.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.pendingAssistantResponsesBySessionId.delete(oldest);
    }
  }

  private shouldIgnoreSession(sessionId: string, currentSessionId: string | null): boolean {
    return (
      sessionId === currentSessionId ||
      this.childSessionIds.has(sessionId) ||
      this.mutedSessionIds.has(sessionId) ||
      isScheduledTaskSessionIgnored(sessionId)
    );
  }

  private emitNotification(notification: BackgroundSessionNotification): void {
    if (!this.onNotification) {
      return;
    }

    const callback = this.onNotification;
    setImmediate(() => {
      Promise.resolve(callback(notification)).catch((error) => {
        logger.error("[BackgroundSessionTracker] Failed to deliver notification:", error);
      });
    });
  }
}

export { BackgroundSessionTracker };
export const backgroundSessionTracker = new BackgroundSessionTracker();
