import {
  getScheduledTaskSessionIgnores,
  setScheduledTaskSessionIgnores,
} from "../stores/settings-store.js";
import { opencodeClient } from "../../opencode/client.js";
import { logger } from "../../utils/logger.js";
import type { ScheduledTaskSessionIgnoreInfo } from "../types/settings.js";

const SCHEDULED_TASK_SESSION_IGNORE_TTL_MS = 24 * 60 * 60 * 1000;

let mutationQueue: Promise<unknown> = Promise.resolve();

function isFreshIgnore(ignore: ScheduledTaskSessionIgnoreInfo, nowMs: number): boolean {
  const createdAtMs = Date.parse(ignore.createdAt);
  return !Number.isNaN(createdAtMs) && nowMs - createdAtMs < SCHEDULED_TASK_SESSION_IGNORE_TTL_MS;
}

function pruneExpiredIgnores(
  ignores: ScheduledTaskSessionIgnoreInfo[],
  nowMs: number,
): ScheduledTaskSessionIgnoreInfo[] {
  return ignores.filter((ignore) => isFreshIgnore(ignore, nowMs));
}

async function mutateIgnores<T>(
  mutator: (ignores: ScheduledTaskSessionIgnoreInfo[]) => {
    ignores: ScheduledTaskSessionIgnoreInfo[];
    result: T;
  },
): Promise<T> {
  const runMutation = async (): Promise<T> => {
    const currentIgnores = getScheduledTaskSessionIgnores();
    const { ignores, result } = mutator(currentIgnores);
    await setScheduledTaskSessionIgnores(ignores);
    return result;
  };

  const mutationPromise = mutationQueue.then(runMutation, runMutation);
  mutationQueue = mutationPromise.catch(() => undefined);
  return mutationPromise;
}

export function isScheduledTaskSessionIgnored(sessionId: string, now = new Date()): boolean {
  const nowMs = now.getTime();
  return getScheduledTaskSessionIgnores().some(
    (ignore) => ignore.sessionId === sessionId && isFreshIgnore(ignore, nowMs),
  );
}

export async function registerScheduledTaskSessionIgnore(
  sessionId: string,
  createdAt = new Date(),
): Promise<void> {
  await mutateIgnores((ignores) => {
    const nowMs = createdAt.getTime();
    const nextIgnores = pruneExpiredIgnores(ignores, nowMs).filter(
      (ignore) => ignore.sessionId !== sessionId,
    );

    return {
      ignores: [...nextIgnores, { sessionId, createdAt: createdAt.toISOString() }],
      result: undefined,
    };
  });
}

export async function removeScheduledTaskSessionIgnore(sessionId: string): Promise<void> {
  await mutateIgnores((ignores) => ({
    ignores: ignores.filter((ignore) => ignore.sessionId !== sessionId),
    result: undefined,
  }));
}

export async function cleanupScheduledTaskSessionIgnores(now = new Date()): Promise<number> {
  const nowMs = now.getTime();
  const expiredSessionIds = getScheduledTaskSessionIgnores()
    .filter((ignore) => !isFreshIgnore(ignore, nowMs))
    .map((ignore) => ignore.sessionId);

  for (const sessionId of expiredSessionIds) {
    // Every ignored id is a temporary scheduled-task session. Runs delete
    // their own session, except runs kept for inspection after an empty
    // response: with the ignore entry gone nothing would ever clean those up.
    try {
      await opencodeClient.session.delete({ sessionID: sessionId });
    } catch (error) {
      logger.debug(
        `[ScheduledTaskSessions] Failed to delete expired temporary session: id=${sessionId}`,
        error,
      );
    }
  }

  return mutateIgnores((ignores) => {
    const nextIgnores = pruneExpiredIgnores(ignores, nowMs);
    return {
      ignores: nextIgnores,
      result: ignores.length - nextIgnores.length,
    };
  });
}

export function __resetScheduledTaskSessionIgnoreForTests(): void {
  mutationQueue = Promise.resolve();
}
