import type { Bot, Context } from "grammy";
import { config } from "../../config.js";
import { opencodeClient } from "../../opencode/client.js";
import {
  getCurrentSession,
  setCurrentSession,
} from "../../app/services/session-service.js";
import { ingestSessionInfoForCache } from "../../app/services/session-cache-service.js";
import { getCurrentProject } from "../../app/stores/settings-store.js";
import { getStoredAgent, resolveProjectAgent } from "../../app/services/agent-selection-service.js";
import { getStoredModel } from "../../app/services/model-selection-service.js";
import { attachToSession, markAttachedSessionBusy } from "../../app/services/attach-service.js";
import { foregroundSessionState } from "../../app/managers/foreground-session-state-manager.js";
import { assistantRunState } from "../../app/managers/assistant-run-state-manager.js";
import { externalUserInputSuppressionManager } from "../../app/managers/external-input-suppression-manager.js";
import { withAgentContext } from "../../app/services/agent-context-service.js";
import { safeBackgroundTask } from "../../utils/safe-background-task.js";
import { formatErrorDetails } from "../../utils/error-format.js";
import { logger } from "../../utils/logger.js";
import { t } from "../../i18n/index.js";
import { isSessionBusy } from "../handlers/prompt.js";
import { setPromptResponseMode } from "../handlers/prompt.js";
import {
  buildInlineResults,
  consumePendingInlineQuery,
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
 * Runs a text-only prompt from an inline query in the current session.
 * Progress and the answer are delivered to the DM chat via the normal
 * SSE pipeline; returns run coordinates for inline in-place streaming.
 */
async function runInlinePrompt(
  bot: Bot<Context>,
  deps: InlineRouterDeps,
  text: string,
): Promise<{ sessionId: string; directory: string; startedAt: number } | null> {
  const chatId = config.telegram.allowedUserId;
  const project = getCurrentProject();
  if (!project) {
    await bot.api.sendMessage(chatId, t("inline.no_project")).catch(() => {});
    return null;
  }

  let session = getCurrentSession();
  if (!session || session.directory !== project.worktree) {
    const { data, error } = await opencodeClient.session.create({
      directory: project.worktree,
    });
    if (error || !data) {
      await bot.api.sendMessage(chatId, t("bot.create_session_error")).catch(() => {});
      return null;
    }
    session = { id: data.id, title: data.title, directory: project.worktree };
    setCurrentSession(session);
    await ingestSessionInfoForCache(data).catch(() => {});
  }

  await attachToSession({
    bot,
    chatId,
    session,
    ensureEventSubscription: deps.ensureEventSubscription,
  });

  if (await isSessionBusy(session.id, session.directory)) {
    await bot.api.sendMessage(chatId, t("bot.session_busy")).catch(() => {});
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
    sessionID: session.id,
    directory: session.directory,
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

  foregroundSessionState.markBusy(session.id, session.directory);
  await markAttachedSessionBusy(session.id);
  assistantRunState.startRun(session.id, {
    startedAt: Date.now(),
    configuredAgent: currentAgent,
    configuredProviderID: storedModel.providerID,
    configuredModelID: storedModel.modelID,
  });
  setPromptResponseMode(session.id, "text_only");
  externalUserInputSuppressionManager.register(session.id, notedText);

  const runContext = {
    sessionId: session.id,
    promptLength: notedText.length,
  };
  const startedAt = Date.now();
  safeBackgroundTask({
    taskName: "session.promptAsync.inline",
    task: () => opencodeClient.session.promptAsync(promptOptions),
    onSuccess: ({ error }) => {
      if (error) {
        foregroundSessionState.markIdle(runContext.sessionId);
        assistantRunState.clearRun(runContext.sessionId, "inline_prompt_api_error");
        logger.error(
          "[Bot] OpenCode API returned an error for inline promptAsync",
          runContext,
        );
        logger.error(
          "[Bot] inline promptAsync error details:",
          formatErrorDetails(error, 6000),
        );
        void bot.api.sendMessage(chatId, t("bot.prompt_send_error")).catch(() => {});
      }
    },
    onError: (error) => {
      foregroundSessionState.markIdle(runContext.sessionId);
      assistantRunState.clearRun(runContext.sessionId, "inline_prompt_background_error");
      logger.error("[Bot] inline promptAsync background task failed", runContext);
      logger.error("[Bot] inline promptAsync background failure details:", formatErrorDetails(error, 6000));
      void bot.api.sendMessage(chatId, t("bot.prompt_send_error")).catch(() => {});
    },
  });

  return { sessionId: session.id, directory: session.directory, startedAt };
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

/**
 * Streams the run result into the chosen inline message in place, so the
 * answer lands in the same chat without adding the bot anywhere.
 */
async function streamInlineAnswer(
  api: Bot<Context>["api"],
  inlineMessageId: string,
  sessionId: string,
  directory: string,
  startedAt: number,
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
      if (await editInlineMessage(api, inlineMessageId, snapshot.text)) {
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
  }
}

export function registerInlineRouter(bot: Bot<Context>, deps: InlineRouterDeps): void {
  bot.on("inline_query", async (ctx) => {
    const inlineQuery = ctx.inlineQuery;
    if (!inlineQuery || inlineQuery.from.id !== config.telegram.allowedUserId) {
      await ctx.answerInlineQuery([], { cache_time: 0, is_personal: true }).catch(() => {});
      return;
    }
    try {
      const results = buildInlineResults(inlineQuery.query ?? "", buildSnapshot());
      await ctx.answerInlineQuery(results, { cache_time: 0, is_personal: true });
    } catch (err) {
      logger.error("[Bot] Error answering inline query:", err);
      await ctx.answerInlineQuery([], { cache_time: 0, is_personal: true }).catch(() => {});
    }
  });

  bot.on("chosen_inline_result", async (ctx) => {
    const chosen = ctx.chosenInlineResult;
    if (!chosen || chosen.from.id !== config.telegram.allowedUserId) {
      return;
    }
    const queryText = consumePendingInlineQuery(chosen.result_id);
    if (!queryText) {
      logger.warn(
        `[Bot] Ignoring inline tap with unknown result id (typed before a restart?): result_id=${chosen.result_id}`,
      );
      return;
    }
    logger.info(`[Bot] Inline tap accepted: queryLength=${queryText.length}`);
    try {
      const run = await runInlinePrompt(bot, deps, queryText);
      if (run && chosen.inline_message_id) {
        void streamInlineAnswer(
          bot.api,
          chosen.inline_message_id,
          run.sessionId,
          run.directory,
          run.startedAt,
        );
      }
    } catch (err) {
      logger.error("[Bot] Error running inline prompt:", err);
      await bot.api
        .sendMessage(config.telegram.allowedUserId, t("error.generic"))
        .catch(() => {});
    }
  });
}
