import type { Api } from "grammy";
import { config } from "../../config.js";
import type { SessionInfo } from "../types/session.js";
import {
  clearSessionTopicId,
  flushSettings,
  getSessionTopicId,
  getSessionTopicMap,
  setSessionTopicId,
} from "../stores/settings-store.js";
import { logger } from "../../utils/logger.js";

// Telegram General topic id. Messages there carry thread 1 or no thread at all.
const GENERAL_THREAD_ID = 1;
const MAX_TOPIC_NAME_LENGTH = 128;

// Chats where topic creation already failed (e.g. Threaded Mode off).
// Remembered for the process lifetime to avoid retrying on every attach.
const unsupportedChats = new Set<number>();
const createInFlight = new Map<string, Promise<number | null>>();

/** Thread id from an inbound message, or null for General / missing. */
export function extractInboundThreadId(
  message: { message_thread_id?: number | undefined } | undefined,
): number | null {
  const threadId = message?.message_thread_id;
  if (typeof threadId !== "number" || !Number.isSafeInteger(threadId)) {
    return null;
  }
  if (threadId <= GENERAL_THREAD_ID) {
    return null;
  }
  return threadId;
}

function buildTopicName(session: SessionInfo): string {
  return formatTopicName(session.title || "", session.id);
}

/** Single-line topic name (max 128 chars) with a session-id fallback. */
export function formatTopicName(title: string, sessionId: string): string {
  const raw = title.split("\n")[0]?.trim() || `Session ${sessionId.slice(0, 8)}`;
  return raw.length > MAX_TOPIC_NAME_LENGTH ? raw.slice(0, MAX_TOPIC_NAME_LENGTH) : raw;
}

/** Topic bound to a session, or null when DM topics are off/unmapped. */
export function getBoundTopicId(sessionId: string): number | null {
  if (!config.bot.dmTopicsEnabled || !sessionId) {
    return null;
  }
  return getSessionTopicId(sessionId);
}

/**
 * Returns the DM topic for a session, creating it on first use.
 * Never throws: returns null when topics are unavailable so callers
 * transparently fall back to the main chat.
 */
export async function ensureSessionTopic(
  api: Pick<Api, "createForumTopic">,
  chatId: number,
  session: SessionInfo,
): Promise<number | null> {
  if (!config.bot.dmTopicsEnabled || !session?.id) {
    return null;
  }

  const existing = getSessionTopicId(session.id);
  if (existing) {
    return existing;
  }

  if (unsupportedChats.has(chatId)) {
    return null;
  }

  const inFlight = createInFlight.get(session.id);
  if (inFlight) {
    return inFlight;
  }

  const task = (async (): Promise<number | null> => {
    try {
      const topic = await api.createForumTopic(chatId, buildTopicName(session));
      const threadId = topic?.message_thread_id;
      if (typeof threadId !== "number" || !Number.isSafeInteger(threadId)) {
        logger.warn("[DmTopics] Topic created without a thread id, skipping binding");
        return null;
      }
      setSessionTopicId(session.id, threadId);
      // Make the binding crash-safe: settings writes are queued, and a restart
      // before the flush would orphan the topic (duplicate on next bind).
      await flushSettings().catch((error: unknown) => {
        logger.warn("[DmTopics] Failed to persist topic binding:", error);
      });
      logger.info(`[DmTopics] Created topic for session: session=${session.id}, thread=${threadId}`);
      return threadId;
    } catch (error) {
      logger.warn("[DmTopics] Topic creation failed, continuing in main chat:", error);
      unsupportedChats.add(chatId);
      return null;
    } finally {
      createInFlight.delete(session.id);
    }
  })();

  createInFlight.set(session.id, task);
  return task;
}

/** Drops a stale binding (e.g. topic was deleted) so it is recreated on demand. */
export function forgetSessionTopic(sessionId: string): void {
  if (!sessionId) {
    return;
  }
  clearSessionTopicId(sessionId);
}

/**
 * Renames a bound topic to follow the session title (best effort).
 * Used when OpenCode generates the real title after the first exchange,
 * or when the user renames the session.
 */
export async function renameSessionTopic(
  api: Pick<Api, "editForumTopic">,
  chatId: number,
  sessionId: string,
  title: string,
): Promise<void> {
  if (!config.bot.dmTopicsEnabled || !sessionId) {
    return;
  }
  const threadId = getSessionTopicId(sessionId);
  if (!threadId) {
    return;
  }
  try {
    await api.editForumTopic(chatId, threadId, { name: formatTopicName(title, sessionId) });
    logger.debug(`[DmTopics] Renamed topic: session=${sessionId}, thread=${threadId}`);
  } catch (error) {
    logger.warn("[DmTopics] Topic rename failed:", error);
  }
}

/**
 * Binds an inbound thread to the current session when nobody owns it yet.
 * Never steals a topic already bound to another session.
 */
export function adoptInboundThread(sessionId: string, threadId: number | null): void {
  if (!config.bot.dmTopicsEnabled || !sessionId || !threadId) {
    return;
  }
  if (getSessionTopicId(sessionId)) {
    return;
  }
  const owner = Object.entries(getSessionTopicMap()).find(([, bound]) => bound === threadId)?.[0];
  if (owner && owner !== sessionId) {
    return;
  }
  setSessionTopicId(sessionId, threadId);
  logger.debug(`[DmTopics] Adopted inbound thread: session=${sessionId}, thread=${threadId}`);
}
