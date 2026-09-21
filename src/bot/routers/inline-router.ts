import type { Bot, Context } from "grammy";
import { isAllowedTelegramUser } from "../../config.js";
import { opencodeClient } from "../../opencode/client.js";
import { getCurrentSession } from "../../app/services/session-service.js";
import { ingestSessionInfoForCache } from "../../app/services/session-cache-service.js";
import { getCurrentProject } from "../../app/stores/settings-store.js";
import { getStoredAgent, resolveProjectAgent } from "../../app/services/agent-selection-service.js";
import { getStoredModel } from "../../app/services/model-selection-service.js";
import { backgroundSessionTracker } from "../../app/managers/background-session-manager.js";
import { withAgentContext } from "../../app/services/agent-context-service.js";
import { safeBackgroundTask } from "../../utils/safe-background-task.js";
import { formatErrorDetails } from "../../utils/error-format.js";
import { logger } from "../../utils/logger.js";
import { t } from "../../i18n/index.js";
import { isSessionBusy } from "../handlers/prompt.js";
import {
  buildInlineResults,
  consumePendingInlineQuery,
  formatInlineAnswer,
  truncateInlineText,
  type InlineSnapshot,
} from "../inline/inline-results.js";
import { pinnedMessageManager } from "../pinned/pinned-message-manager.js";
import { formatContextLine } from "../pinned/pinned-message-format.js";

interface InlineRouterDeps {
  ensureEventSubscription: (directory: string) => Promise<void>;
}

function buildSnapshot(): InlineSnapshot {
  const project = getCurrentProject();
  const session = getCurrentSession();
  const model = getStoredModel();
  const contextInfo = pinnedMessageManager.getContextInfo();
  return {
    projectName: project?.worktree ?? null,
    sessionTitle: session?.title ?? null,
    modelLabel:
      model.providerID && model.modelID ? `${model.providerID}/${model.modelID}` : null,
    contextLine: contextInfo
      ? formatContextLine(contextInfo.tokensUsed, contextInfo.tokensLimit)
      : null,
  };
}

/**
 * Dedicated session for inline runs. It is never set as the current session
 * and never attached, so nothing leaks into the DM chat: the DM pipeline
 * only delivers for the current session, and background notifications for
 * this session are muted. One per project directory, reused across asks.
 */
const INLINE_SESSION_TITLE = "⚡ Inline";

let inlineRunInFlight = false;

interface InlineSession {
  id: string;
  directory: string;
}

async function findInlineSession(directory: string): Promise<InlineSession | null> {
  const { data, error } = await opencodeClient.session.list({
    directory,
    limit: 50,
    roots: true,
  });
  if (error || !data) {
    return null;
  }
  const found = (data as Array<{ id?: string; title?: string }>).find(
    (session) => typeof session.id === "string" && session.title === INLINE_SESSION_TITLE,
  );
  return found?.id ? { id: found.id, directory } : null;
}

async function getInlineSession(directory: string): Promise<InlineSession | null> {
  const existing = await findInlineSession(directory).catch(() => null);
  if (existing) {
    return existing;
  }
  const { data, error } = await opencodeClient.session.create({ directory });
  if (error || !data?.id) {
    return null;
  }
  await opencodeClient.session
    .update({ sessionID: data.id, directory, title: INLINE_SESSION_TITLE })
    .catch(() => {});
  await ingestSessionInfoForCache(data).catch(() => {});
  return { id: data.id, directory };
}

/**
 * Runs a text-only prompt from an inline query in the dedicated inline
 * session. Nothing is sent to the DM chat: failures are reported through
 * onFailureNotice so the caller can edit the inline message instead.
 */
async function runInlinePrompt(
  deps: InlineRouterDeps,
  text: string,
  onFailureNotice: (notice: string) => void,
): Promise<{ sessionId: string; directory: string; startedAt: number } | null> {
  const project = getCurrentProject();
  if (!project) {
    onFailureNotice(t("inline.no_project"));
    return null;
  }
  if (inlineRunInFlight) {
    onFailureNotice(t("bot.session_busy"));
    return null;
  }

  const inlineSession = await getInlineSession(project.worktree).catch(() => null);
  if (!inlineSession) {
    onFailureNotice(t("bot.create_session_error"));
    return null;
  }

  backgroundSessionTracker.setMuted(inlineSession.id, true);
  try {
    await deps.ensureEventSubscription(project.worktree);
  } catch (error) {
    logger.warn("[Bot] Inline event subscription failed:", error);
    onFailureNotice(t("bot.create_session_error"));
    return null;
  }

  if (await isSessionBusy(inlineSession.id, inlineSession.directory)) {
    onFailureNotice(t("bot.session_busy"));
    return null;
  }

  const currentAgent = await resolveProjectAgent(getStoredAgent());
  const storedModel = getStoredModel();
  const notedText = withAgentContext(text);
  const promptOptions: {
    sessionID: string;
    directory: string;
    parts: Array<{ type: "text"; text: string }>;
    model?: { providerID: string; modelID: string };
    agent?: string;
    variant?: string;
  } = {
    sessionID: inlineSession.id,
    directory: inlineSession.directory,
    parts: [{ type: "text", text: notedText }],
    agent: currentAgent,
  };
  if (storedModel.providerID && storedModel.modelID) {
    promptOptions.model = {
      providerID: storedModel.providerID,
      modelID: storedModel.modelID,
    };
  }
  if (storedModel.variant) {
    promptOptions.variant = storedModel.variant;
  }

  const runContext = {
    sessionId: inlineSession.id,
    promptLength: notedText.length,
  };
  const startedAt = Date.now();
  inlineRunInFlight = true;
  safeBackgroundTask({
    taskName: "session.promptAsync.inline",
    task: () => opencodeClient.session.promptAsync(promptOptions),
    onSuccess: ({ error }) => {
      if (error) {
        inlineRunInFlight = false;
        logger.error(
          "[Bot] OpenCode API returned an error for inline promptAsync",
          runContext,
        );
        logger.error(
          "[Bot] inline promptAsync error details:",
          formatErrorDetails(error, 6000),
        );
        onFailureNotice(t("bot.prompt_send_error"));
      }
    },
    onError: (error) => {
      inlineRunInFlight = false;
      logger.error("[Bot] inline promptAsync background task failed", runContext);
      logger.error("[Bot] inline promptAsync background failure details:", formatErrorDetails(error, 6000));
      onFailureNotice(t("bot.prompt_send_error"));
    },
  });

  return { sessionId: inlineSession.id, directory: inlineSession.directory, startedAt };
}

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

const INLINE_POLL_INTERVAL_MS = 3000;
const INLINE_RUN_TIMEOUT_MS = 10 * 60 * 1000;
const INLINE_EDIT_THROTTLE_MS = 20000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readInlineSnapshot(
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
  let best: { created: number; text: string; completed: boolean } | null = null;
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
    if (!best || created >= best.created) {
      best = { created, text, completed: Boolean(message.info.time?.completed) };
    }
  }
  return best;
}

async function editInlineMessage(
  api: Bot<Context>["api"],
  inlineMessageId: string,
  text: string,
): Promise<boolean> {
  const trimmed = truncateInlineText(text);
  try {
    await api.editMessageTextInline(inlineMessageId, trimmed, { parse_mode: "Markdown" });
    return true;
  } catch (error) {
    logger.debug("[Bot] Inline Markdown edit failed, retrying as plain text", error);
  }
  try {
    await api.editMessageTextInline(inlineMessageId, trimmed);
    return true;
  } catch (error) {
    logger.warn("[Bot] Inline message edit failed:", error);
    return false;
  }
}

async function isRunIdle(sessionId: string, directory: string): Promise<boolean> {
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

/**
 * Streams the run result into the chosen inline message in place, so the
 * answer lands in the same chat without adding the bot anywhere.
 * Aborted/errored runs end the placeholder with an interruption note
 * instead of leaving it stuck.
 */
async function streamInlineAnswer(
  api: Bot<Context>["api"],
  inlineMessageId: string,
  sessionId: string,
  directory: string,
  startedAt: number,
  query: string,
): Promise<void> {
  const deadline = Date.now() + INLINE_RUN_TIMEOUT_MS;
  let lastSent = "";
  let lastEditAt = 0;
  logger.info(`[Bot] Streaming inline answer: session=${sessionId}`);
  for (;;) {
    await sleep(INLINE_POLL_INTERVAL_MS);
    const snapshot = await readInlineSnapshot(sessionId, directory, startedAt).catch(() => null);
    const now = Date.now();
    if (snapshot && snapshot.text !== lastSent && (snapshot.completed || now - lastEditAt >= INLINE_EDIT_THROTTLE_MS)) {
      if (await editInlineMessage(api, inlineMessageId, formatInlineAnswer(query, snapshot.text))) {
        lastSent = snapshot.text;
        lastEditAt = now;
      }
      if (snapshot.completed) {
        logger.info(`[Bot] Inline answer delivered: session=${sessionId}`);
        return;
      }
    } else if (snapshot?.completed || now > deadline) {
      if (now > deadline) {
        logger.warn(`[Bot] Inline answer timed out: session=${sessionId}`);
      }
      return;
    }
    // The run died without a completion (abort/error): don't poll till timeout.
    if (!snapshot && lastSent && (await isRunIdle(sessionId, directory))) {
      logger.info(`[Bot] Inline run went idle, keeping last text: session=${sessionId}`);
      return;
    }
    if (!snapshot && !lastSent && now > deadline) {
      await editInlineMessage(api, inlineMessageId, t("inline.interrupted"));
      return;
    }
  }
}

export function registerInlineRouter(bot: Bot<Context>, deps: InlineRouterDeps): void {
  bot.on("inline_query", async (ctx) => {
    const inlineQuery = ctx.inlineQuery;
    if (!inlineQuery || !isAllowedTelegramUser(inlineQuery.from.id)) {
      await ctx.answerInlineQuery([], { cache_time: 0, is_personal: true }).catch(() => {});
      return;
    }
    logger.info(
      `[Bot] Inline query: from=${inlineQuery.from.id}, queryLength=${(inlineQuery.query ?? "").length}`,
    );
    try {
      const botUsername = bot.botInfo?.username ?? null;
      if (!botUsername) {
        logger.warn("[Bot] Bot username unknown, inline answers cannot be edited in place");
      }
      const results = buildInlineResults(inlineQuery.query ?? "", buildSnapshot(), botUsername);
      await ctx.answerInlineQuery(results, { cache_time: 0, is_personal: true });
    } catch (err) {
      logger.error("[Bot] Error answering inline query:", err);
      await ctx.answerInlineQuery([], { cache_time: 0, is_personal: true }).catch((error: unknown) => {
        logger.warn("[Bot] Fallback empty inline answer failed:", error);
      });
    }
  });

  bot.on("chosen_inline_result", async (ctx) => {
    const chosen = ctx.chosenInlineResult;
    if (!chosen || !isAllowedTelegramUser(chosen.from.id)) {
      return;
    }
    logger.info(
      `[Bot] Inline chosen: from=${chosen.from.id}, result_id=${chosen.result_id}, hasInlineMessage=${Boolean(chosen.inline_message_id)}`,
    );
    const queryText = consumePendingInlineQuery(chosen.result_id);
    if (!queryText) {
      logger.warn(
        `[Bot] Ignoring inline tap with unknown result id (typed before a restart?): result_id=${chosen.result_id}`,
      );
      return;
    }
    logger.info(`[Bot] Inline tap accepted: queryLength=${queryText.length}`);
    const inlineMessageId = chosen.inline_message_id;
    if (!inlineMessageId) {
      logger.warn("[Bot] Inline tap has no inline_message_id, cannot answer in place");
      return;
    }
    const notifyInline = (notice: string) => {
      void editInlineMessage(bot.api, inlineMessageId, formatInlineAnswer(queryText, notice));
    };
    try {
      const run = await runInlinePrompt(deps, queryText, notifyInline);
      if (run) {
        void streamInlineAnswer(
          bot.api,
          inlineMessageId,
          run.sessionId,
          run.directory,
          run.startedAt,
          queryText,
        ).finally(() => {
          inlineRunInFlight = false;
        });
      }
    } catch (err) {
      logger.error("[Bot] Error running inline prompt:", err);
      notifyInline(t("error.generic"));
    }
  });
}
