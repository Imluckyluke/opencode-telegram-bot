import type { Bot, Context } from "grammy";
import type { FilePartInput } from "@opencode-ai/sdk/v2";
import { isAllowedTelegramUser } from "../../config.js";
import { opencodeClient } from "../../opencode/client.js";
import { getCurrentSession } from "../../app/services/session-service.js";
import { ingestSessionInfoForCache } from "../../app/services/session-cache-service.js";
import { getCurrentProject } from "../../app/stores/settings-store.js";
import { getStoredAgent, resolveProjectAgent } from "../../app/services/agent-selection-service.js";
import { getStoredInlineModel, getStoredModel } from "../../app/services/model-selection-service.js";
import { backgroundSessionTracker } from "../../app/managers/background-session-manager.js";
import { withAgentContext } from "../../app/services/agent-context-service.js";
import { prepareGuestFiles, type GuestFileInput } from "../inline/guest-files.js";
import { isSttConfigured } from "../../app/services/stt-service.js";
import { safeBackgroundTask } from "../../utils/safe-background-task.js";
import { formatErrorDetails } from "../../utils/error-format.js";
import { logger } from "../../utils/logger.js";
import { t } from "../../i18n/index.js";
import { isSessionBusy } from "../handlers/prompt.js";
import {
  buildInlineResults,
  consumePendingInlineQuery,
  extractGuestDocument,
  extractGuestPhoto,
  extractGuestReplyText,
  extractGuestVoice,
  formatInlineAnswer,
  guestVoiceFilename,
  stripBotMention,
  truncateInlineText,
  type InlineSnapshot,
} from "../inline/inline-results.js";
import { renderAssistantFinalPartsSafe } from "../messages/assistant-rendering.js";
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
/**
 * Every inline/guest ask runs in a FRESH session titled after the question,
 * so answers can never bleed in from previous asks' memory. Nothing is sent
 * to the DM chat: failures are reported through onFailureNotice so the
 * caller can edit the inline message instead.
 */
const INLINE_SESSION_TITLE_PREFIX = "⚡ ";

let inlineRunInFlight = false;

function inlineSessionTitle(question: string): string {
  const snippet = question.replace(/\s+/g, " ").trim().slice(0, 40) || "ask";
  return `${INLINE_SESSION_TITLE_PREFIX}${snippet}`;
}

interface InlineSession {
  id: string;
  directory: string;
}

async function createInlineSession(
  directory: string,
  question: string,
): Promise<InlineSession | null> {
  const { data, error } = await opencodeClient.session.create({ directory });
  if (error || !data?.id) {
    return null;
  }
  await opencodeClient.session
    .update({ sessionID: data.id, directory, title: inlineSessionTitle(question) })
    .catch(() => {});
  await ingestSessionInfoForCache(data).catch(() => {});
  return { id: data.id, directory };
}
async function runInlinePrompt(
  deps: InlineRouterDeps,
  api: Bot<Context>["api"],
  text: string,
  onFailureNotice: (notice: string) => void,
  files: GuestFileInput[] = [],
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

  const inlineSession = await createInlineSession(project.worktree, text).catch(() => null);
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
  const inlineModel = getStoredInlineModel();
  const { prependText, fileParts } = await prepareGuestFiles(
    api,
    { providerID: inlineModel.providerID, modelID: inlineModel.modelID },
    files,
  );
  const notedText = withAgentContext(prependText ? `${prependText}${text}` : text);
  const promptOptions: {
    sessionID: string;
    directory: string;
    parts: Array<{ type: "text"; text: string } | FilePartInput>;
    model?: { providerID: string; modelID: string };
    agent?: string;
    variant?: string;
  } = {
    sessionID: inlineSession.id,
    directory: inlineSession.directory,
    parts: [{ type: "text", text: notedText }, ...fileParts],
    agent: currentAgent,
  };
  promptOptions.model = {
    providerID: inlineModel.providerID,
    modelID: inlineModel.modelID,
  };
  if (inlineModel.variant) {
    promptOptions.variant = inlineModel.variant;
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
const INLINE_EDIT_THROTTLE_MS = 10000;

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

const INLINE_RICH_BUDGET_CHARS = 30000;

async function editInlineMessage(
  api: Bot<Context>["api"],
  inlineMessageId: string,
  query: string,
  answer: string,
  includeQuestion = true,
): Promise<boolean> {
  // 1. Native rich blocks: the question becomes a real quote block, tables
  // stay real tables — same rendering as the DM chat. Guest answers skip the
  // question: they already reply to the user's message.
  const questionPrefix = includeQuestion ? `> ${query.trim()}\n\n` : "";
  try {
    const richSource = `${questionPrefix}${answer.trim()}`;
    const parts = renderAssistantFinalPartsSafe(truncateInlineText(richSource, INLINE_RICH_BUDGET_CHARS));
    const blocks = parts.flatMap((part) => part.blocks);
    if (blocks.length > 0) {
      await api.editMessageTextInline(inlineMessageId, { blocks });
      return true;
    }
  } catch (error) {
    logger.debug("[Bot] Inline rich edit failed, retrying as Markdown", error);
  }
  // 2. Classic Markdown text (no native tables, but widely supported).
  const trimmed = truncateInlineText(
    includeQuestion ? formatInlineAnswer(query, answer) : answer,
  );
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
  includeQuestion = true,
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
      if (await editInlineMessage(api, inlineMessageId, query, snapshot.text, includeQuestion)) {
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
      await editInlineMessage(api, inlineMessageId, query, t("inline.interrupted"), includeQuestion);
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
      void editInlineMessage(bot.api, inlineMessageId, queryText, notice);
    };
    try {
      const run = await runInlinePrompt(deps, bot.api, queryText, notifyInline);
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

  bot.on("guest_message", async (ctx) => {
    const guest = ctx.guestMessage;
    // The summoner arrives as guest_bot_caller_user, or for direct summons
    // as the message sender itself.
    const callerId = guest?.guest_bot_caller_user?.id ?? guest?.from?.id;
    // Authoritative check: the summoner must be whitelisted (auth middleware
    // already passed on sender-or-caller).
    if (!guest || !isAllowedTelegramUser(callerId)) {
      logger.warn(`[Bot] Ignoring guest message: caller=${callerId}`);
      return;
    }
    const text = (guest.text ?? guest.caption ?? "").trim().slice(0, 4000);
    const files: GuestFileInput[] = [];
    const photo = extractGuestPhoto(guest);
    if (photo) {
      files.push({ kind: "photo", fileId: photo.fileId, fileSize: photo.fileSize });
    }
    const document = extractGuestDocument(guest);
    if (document) {
      files.push({
        kind: "document",
        fileId: document.fileId,
        fileSize: document.fileSize,
        mime: document.mime,
        filename: document.filename,
      });
    }
    const voice = extractGuestVoice(guest);
    if (voice) {
      files.push({
        kind: "voice",
        fileId: voice.fileId,
        fileSize: voice.fileSize,
        mime: voice.mime,
        filename: guestVoiceFilename(voice.mime),
      });
    }
    if (!text && files.length === 0) {
      logger.info(`[Bot] Ignoring guest message without text or files: caller=${callerId}`);
      return;
    }
    // Answer immediately with a working placeholder; the returned
    // inline_message_id lets us stream the real answer into it in place.
    const botUsername = bot.botInfo?.username ?? null;
    const ownText = stripBotMention(text, botUsername);
    const replyText = extractGuestReplyText(guest);
    const promptText = replyText ? `> ${replyText}\n\n${ownText}` : ownText;
    const question = ownText || (files.length === 1 ? "See attached file" : "See attached files");
    logger.info(`[Bot] Guest summons accepted: caller=${callerId}, queryLength=${question.length}, files=${files.length}, hasReply=${Boolean(replyText)}`);
    let sent;
    try {
      sent = await ctx.answerGuestQuery({
        type: "article",
        id: `guest${Date.now().toString(36)}`,
        title: t("inline.ask.title"),
        input_message_content: {
          message_text: t("inline.posted.text", { query: question }),
        },
        ...(botUsername
          ? {
              reply_markup: {
                inline_keyboard: [
                  [{ text: t("inline.open_bot"), url: `https://t.me/${botUsername}` }],
                ],
              },
            }
          : {}),
      });
    } catch (err) {
      logger.error("[Bot] Error answering guest query:", err);
      return;
    }

    const inlineMessageId = sent?.inline_message_id;
    if (!inlineMessageId) {
      logger.warn("[Bot] Guest answer has no inline_message_id, cannot stream result");
      return;
    }
    const notifyGuest = (notice: string) => {
      void editInlineMessage(bot.api, inlineMessageId, question, notice, false);
    };
    if (files.some((file) => file.kind === "voice") && !isSttConfigured()) {
      notifyGuest(t("stt.not_configured"));
      return;
    }
    try {
      const run = await runInlinePrompt(deps, bot.api, promptText, notifyGuest, files);
      if (run) {
        void streamInlineAnswer(
          bot.api,
          inlineMessageId,
          run.sessionId,
          run.directory,
          run.startedAt,
          question,
          false,
        ).finally(() => {
          inlineRunInFlight = false;
        });
      }
    } catch (err) {
      logger.error("[Bot] Error running guest prompt:", err);
      notifyGuest(t("error.generic"));
    }
  });
}
