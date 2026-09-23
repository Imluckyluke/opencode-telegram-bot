import { opencodeClient } from "../../opencode/client.js";
import { logger } from "../../utils/logger.js";

/**
 * One persistent OpenCode session per guest chat (group), so consecutive
 * summons in the same chat share conversational memory instead of starting
 * blank every time. Entries are bounded (LRU cap) and expire after a TTL;
 * evicted sessions are deleted server-side on a best-effort basis.
 */
export interface GuestChatSession {
  sessionId: string;
  directory: string;
  projectWorktree: string;
  lastUsedAt: number;
}

const MAX_GUEST_CHAT_SESSIONS = 20;
const GUEST_CHAT_SESSION_TTL_MS = 24 * 60 * 60 * 1000;

const sessionsByChatId = new Map<number, GuestChatSession>();

function isExpired(session: GuestChatSession, now: number): boolean {
  return now - session.lastUsedAt >= GUEST_CHAT_SESSION_TTL_MS;
}

function deleteServerSession(sessionId: string): void {
  void opencodeClient.session
    .delete({ sessionID: sessionId })
    .catch((error: unknown) => {
      logger.debug(`[GuestSessions] Failed to delete evicted session: id=${sessionId}`, error);
    });
}

function evictChatSession(chatId: number): void {
  const session = sessionsByChatId.get(chatId);
  if (!session) {
    return;
  }

  sessionsByChatId.delete(chatId);
  deleteServerSession(session.sessionId);
}

function evictOverflow(): void {
  while (sessionsByChatId.size > MAX_GUEST_CHAT_SESSIONS) {
    const oldest = sessionsByChatId.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    evictChatSession(oldest);
  }
}

/**
 * Returns the live session for a chat, or null when there is none, it
 * expired, or it belongs to a different project worktree. Expired and
 * foreign entries are evicted (server session deleted best-effort).
 */
export function getGuestChatSession(chatId: number, projectWorktree: string): GuestChatSession | null {
  const session = sessionsByChatId.get(chatId);
  if (!session) {
    return null;
  }

  if (isExpired(session, Date.now()) || session.projectWorktree !== projectWorktree) {
    evictChatSession(chatId);
    return null;
  }

  return session;
}

/** Records (or refreshes) the session for a chat. */
export function setGuestChatSession(
  chatId: number,
  session: Omit<GuestChatSession, "lastUsedAt">,
): void {
  sessionsByChatId.delete(chatId);
  sessionsByChatId.set(chatId, { ...session, lastUsedAt: Date.now() });
  evictOverflow();
}

/** Refreshes the last-used timestamp after a successful run. */
export function touchGuestChatSession(chatId: number): void {
  const session = sessionsByChatId.get(chatId);
  if (session) {
    session.lastUsedAt = Date.now();
  }
}

/** Drops every tracked chat session (tests / full resets only). */
export function clearGuestChatSessions(): void {
  sessionsByChatId.clear();
}

/** Test helper: resets module state without touching the server. */
export function __resetGuestChatSessionsForTests(): void {
  sessionsByChatId.clear();
}
