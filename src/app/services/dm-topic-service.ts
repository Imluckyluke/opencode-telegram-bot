import type { Api } from "grammy";
import { config } from "../../config.js";
import type { SessionInfo } from "../types/session.js";
import {
  clearSessionTopicId,
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
  const raw = (session.title || "").split("\n")[0]?.trim() || `Session ${session.id.slice(0, 8)}`;
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
