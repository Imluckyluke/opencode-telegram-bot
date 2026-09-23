import { opencodeClient } from "../../opencode/client.js";
import { logger } from "../../utils/logger.js";

type SessionMessageLike = {
  info: {
    role?: string;
    summary?: boolean;
    time?: {
      created?: number;
      completed?: number;
    };
  };
  parts: Array<{ type?: string; text?: string }>;
};

export const RUN_WAITER_POLL_MS = 3000;
export const RUN_WAITER_TIMEOUT_MS = 10 * 60 * 1000;
export const RUN_WAITER_EDIT_THROTTLE_MS = 10000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function readRunSnapshot(
  sessionId: string,
  directory: string,
  since: number,
): Promise<{ text: string; completed: boolean } | null> {
  const { data, error } = await opencodeClient.session.messages({
    sessionID: sessionId,
    directory,
  });
  if (error || !data) {
    return null;
  }
  // An answer can span several assistant messages (e.g. text plus a table):
  // concatenate all of them in order instead of keeping only the latest.
  const collected: Array<{ created: number; text: string; completed: boolean }> = [];
  for (const message of data as SessionMessageLike[]) {
    if (message.info.role !== "assistant" || message.info.summary) {
      continue;
    }
    const created = message.info.time?.created ?? 0;
    if (created < since) {
      continue;
    }
    const text = message.parts
      .filter((part) => part.type === "text" && typeof part.text === "string")
      .map((part) => part.text as string)
      .join("")
      .trim();
    if (!text) {
      continue;
    }
    collected.push({ created, text, completed: Boolean(message.info.time?.completed) });
  }
  if (collected.length === 0) {
    return null;
  }
  collected.sort((a, b) => a.created - b.created);
  const last = collected[collected.length - 1] as { text: string; completed: boolean };
  return {
    text: collected.map((entry) => entry.text).join("\n\n"),
    completed: last.completed,
  };
}

export async function isRunIdle(sessionId: string, directory: string): Promise<boolean> {
  try {
    const { data, error } = await opencodeClient.session.status({ directory });
    if (error || !data) {
      return false;
    }
    const status = (data as Record<string, { type?: string }>)[sessionId];
    return !status || status.type !== "busy";
  } catch {
    return false;
  }
}

export interface RunWaiterResult {
  /** Latest full text (may be partial when the run died mid-way). */
  text: string;
  /** True when a completion was observed (answer fully delivered). */
  completed: boolean;
  /**
   * Set when the run asked an interactive question/permission: guest and
   * inline runs have no way to answer those, so the request was rejected and
   * the session aborted instead of hanging until the timeout.
   */
  blocked?: "question" | "permission";
}

export interface WaitForCompletionOptions {
  sessionId: string;
  directory: string;
  startedAt: number;
  timeoutMs?: number;
  pollMs?: number;
  throttleMs?: number;
  /** Called with new text; return true when it was delivered. */
  onProgress: (text: string, completed: boolean) => Promise<boolean>;
  /**
   * When true, a pending question/permission for the session fails fast
   * (reject + abort) instead of holding the run until the timeout. Opt-in:
   * DM flows keep waiting so interactive runs can be answered in chat.
   */
  failFastOnInteractive?: boolean;
}

type PendingInteractiveRequest =
  | { kind: "question"; id: string }
  | { kind: "permission"; id: string };

async function detectInteractiveRequest(
  sessionId: string,
  directory: string,
): Promise<PendingInteractiveRequest | null> {
  try {
    const [questionsResult, permissionsResult] = await Promise.all([
      opencodeClient.question.list({ directory }),
      opencodeClient.permission.list({ directory }),
    ]);
    const question = questionsResult.data?.find(
      (request) => (request as { sessionID?: string }).sessionID === sessionId,
    );
    if (question) {
      return { kind: "question", id: (question as { id: string }).id };
    }
    const permission = permissionsResult.data?.find(
      (request) => (request as { sessionID?: string }).sessionID === sessionId,
    );
    if (permission) {
      return { kind: "permission", id: (permission as { id: string }).id };
    }
  } catch (error) {
    logger.debug("[Bot] Interactive request check failed, will retry next poll:", error);
  }
  return null;
}

async function rejectInteractiveRequest(
  request: PendingInteractiveRequest,
  sessionId: string,
  directory: string,
): Promise<void> {
  try {
    if (request.kind === "question") {
      await opencodeClient.question.reject({ requestID: request.id, directory });
    } else {
      await opencodeClient.permission.reply({
        requestID: request.id,
        directory,
        reply: "reject",
        message: "This run cannot continue because it requires interactive permission.",
      });
    }
  } catch (error) {
    logger.warn("[Bot] Failed to reject interactive request:", error);
  }

  try {
    await opencodeClient.session.abort({ sessionID: sessionId, directory });
  } catch (error) {
    logger.warn("[Bot] Failed to abort session blocked on interactive input:", error);
  }
}

/**
 * Polls a session until its answer completes: a completed message alone is
 * not the end (the model may continue with tool calls and more messages),
 * only session idleness after observed activity finishes the wait.
 * Aborted/errored runs resolve with partial text so callers never hang.
 */
export async function waitForAssistantCompletion(
  options: WaitForCompletionOptions,
): Promise<RunWaiterResult | null> {
  const {
    sessionId,
    directory,
    startedAt,
    timeoutMs = RUN_WAITER_TIMEOUT_MS,
    pollMs = RUN_WAITER_POLL_MS,
    throttleMs = RUN_WAITER_EDIT_THROTTLE_MS,
    onProgress,
    failFastOnInteractive = false,
  } = options;
  const deadline = Date.now() + timeoutMs;
  let lastSent = "";
  let lastEditAt = 0;
  let observedBusy = false;
  logger.info(`[Bot] Waiting for run completion: session=${sessionId}`);
  for (;;) {
    await sleep(pollMs);
    const snapshot = await readRunSnapshot(sessionId, directory, startedAt).catch(() => null);
    const now = Date.now();
    if (
      snapshot &&
      snapshot.text !== lastSent &&
      (snapshot.completed || now - lastEditAt >= throttleMs)
    ) {
      if (await onProgress(snapshot.text, snapshot.completed)) {
        lastSent = snapshot.text;
        lastEditAt = now;
      }
    }
    if (failFastOnInteractive) {
      const blocked = await detectInteractiveRequest(sessionId, directory);
      if (blocked) {
        logger.warn(`[Bot] Run blocked on ${blocked.kind}, rejecting without waiting: session=${sessionId}`);
        await rejectInteractiveRequest(blocked, sessionId, directory);
        return { text: lastSent, completed: false, blocked: blocked.kind };
      }
    }
    if (now > deadline) {
      logger.warn(`[Bot] Run wait timed out: session=${sessionId}`);
      return lastSent ? { text: lastSent, completed: false } : null;
    }
    const busy = !(await isRunIdle(sessionId, directory).catch(() => false));
    observedBusy = observedBusy || busy;
    if (!busy && observedBusy) {
      if (snapshot && snapshot.text !== lastSent) {
        if (await onProgress(snapshot.text, snapshot.completed)) {
          lastSent = snapshot.text;
        }
      }
      if (lastSent) {
        return { text: lastSent, completed: Boolean(snapshot?.completed) };
      }
      // Idle with nothing ever shown: interrupted (abort/error before output).
      return null;
    }
  }
}
