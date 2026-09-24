import type { Bot, Context } from "grammy";
import type { FilePartInput } from "@opencode-ai/sdk/v2";
import { isAllowedUser } from "../../app/stores/settings-store.js";
import { opencodeClient } from "../../opencode/client.js";
import { ingestSessionInfoForCache } from "../../app/services/session-cache-service.js";
import { getCurrentProject } from "../../app/stores/settings-store.js";
import { getStoredAgent, resolveProjectAgent } from "../../app/services/agent-selection-service.js";
import { getStoredInlineModel } from "../../app/services/model-selection-service.js";
import {
  GUEST_SESSION_PERMISSIONS,
  createSessionWithPermissions,
} from "../../app/services/session-permissions.js";
import { backgroundSessionTracker } from "../../app/managers/background-session-manager.js";
import {
  GLOBAL_RUN_KEY,
  currentInlineRunGeneration,
  guestRunKey,
  isInlineRunInFlight,
  setInlineRunInFlight,
} from "../inline/inline-run-state.js";
import {
  getGuestChatSession,
  setGuestChatSession,
  touchGuestChatSession,
} from "../../app/managers/guest-session-manager.js";
import { withAgentContext } from "../../app/services/agent-context-service.js";
import { prepareGuestFiles, type GuestFileInput } from "../inline/guest-files.js";
import { isSttConfigured } from "../../app/services/stt-service.js";
import { safeBackgroundTask } from "../../utils/safe-background-task.js";
import { formatErrorDetails } from "../../utils/error-format.js";
import { extractErrorMessage } from "../../utils/opencode-error.js";
import { logger } from "../../utils/logger.js";
import { t } from "../../i18n/index.js";
import { isSessionBusy } from "../handlers/prompt.js";
import { getPromptChatId } from "../handlers/prompt.js";
import { collectRunFiles, deliverFirstRunFileAsInlineMedia } from "../inline/guest-run-files.js";
import {
  waitForAssistantCompletion,
} from "../inline/run-waiter.js";
import type { InteractiveQuestion } from "../inline/run-waiter.js";
import {
  GUEST_QUESTION_REPLY_TIMEOUT_MS,
  buildGuestQuestionBlocks,
  claimPendingGuestQuestion,
  clearPendingGuestQuestion,
  parseGuestAnswerNumber,
  renderGuestQuestionTable,
  requeuePendingGuestQuestion,
  restorePendingGuestQuestion,
  setPendingGuestQuestion,
  submitGuestQuestionAnswer,
} from "../inline/guest-questions.js";
import {
  extractGuestDocument,
  extractGuestPhoto,
  extractGuestReplyText,
  extractGuestVideo,
  extractGuestVoice,
  formatInlineAnswer,
  guestVoiceFilename,
  stripBotMention,
  truncateInlineText,
} from "../inline/inline-results.js";
import { renderAssistantFinalPartsSafe } from "../messages/assistant-rendering.js";

interface InlineRouterDeps {
  ensureEventSubscription: (directory: string) => Promise<void>;
}

/**
 * Guest chats keep ONE persistent session per group chat, so consecutive
 * summons in the same chat share conversational memory. Sessions are tracked
 * in guest-session-manager with TTL + LRU bounds; chat identity comes from
 * the server-set guest message chat id.
 */
const INLINE_SESSION_TITLE_PREFIX = "⚡ ";

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
  const { data, error } = await createSessionWithPermissions(
    directory,
    inlineSessionTitle(question),
    GUEST_SESSION_PERMISSIONS,
  );
  if (error || !data?.id) {
    return null;
  }
  await opencodeClient.session
    .update({ sessionID: data.id, directory, title: inlineSessionTitle(question) })
    .catch(() => {});
  await ingestSessionInfoForCache(data).catch(() => {});
  return { id: data.id, directory };
}

/**
 * Resolves the persistent session for a guest chat: reuses the tracked one
 * when it is still alive server-side, otherwise creates (and tracks) a new
 * one. Returns null when no session was recorded and creation failed.
 */
async function resolveGuestChatSession(
  chatId: number,
  projectWorktree: string,
): Promise<InlineSession | null> {
  const mapped = getGuestChatSession(chatId, projectWorktree);
  if (mapped && (await isGuestSessionAlive(mapped.sessionId, mapped.directory))) {
    logger.info(`[Bot] Reusing guest chat session: chat=${chatId}, session=${mapped.sessionId}`);
    return { id: mapped.sessionId, directory: mapped.directory };
  }

  const created = await createInlineSession(projectWorktree, `Guest chat ${chatId}`).catch(
    () => null,
  );
  if (!created) {
    return null;
  }
  logger.info(`[Bot] New guest chat session: chat=${chatId}, session=${created.id}`);
  setGuestChatSession(chatId, {
    sessionId: created.id,
    directory: created.directory,
    projectWorktree,
  });
  return created;
}

async function isGuestSessionAlive(sessionId: string, directory: string): Promise<boolean> {
  try {
    const { error } = await opencodeClient.session.get({ sessionID: sessionId, directory });
    if (!error) {
      return true;
    }
    // Only a positive "not found" means gone; anything else is treated as
    // alive so transient errors surface through the normal prompt path.
    return !extractErrorMessage(error)?.includes("Session not found");
  } catch {
    return true;
  }
}

/**
 * Answers a pending model question when a guest replies with just the option
 * number. Returns true when a pending question existed (answer submitted or
 * input ignored), so the caller skips starting a new run.
 */
async function tryAnswerPendingGuestQuestion(
  api: Bot<Context>["api"],
  chatId: number,
  text: string,
): Promise<boolean> {
  const pending = claimPendingGuestQuestion(chatId);
  if (!pending) {
    return false;
  }

  const pick = parseGuestAnswerNumber(text, pending.options.length);
  if (pick === null) {
    // Not an answer (and the run is still in flight): put the entry back
    // untouched and leave the question table with its instruction visible.
    restorePendingGuestQuestion(chatId, pending);
    logger.debug(`[Bot] Ignoring non-answer while guest question pending: chat=${chatId}`);
    return true;
  }

  const submitted = await submitGuestQuestionAnswer(pending, pick);
  if (!submitted) {
    // Keep the entry with a fresh expiry so the answer can be retried.
    requeuePendingGuestQuestion(chatId, pending);
    return true;
  }

  const label = pending.options[pick]?.label ?? String(pick + 1);
  await editInlineMessage(api, pending.inlineMessageId, pending.question, `✓ ${label}`, false);
  return true;
}
async function runInlinePrompt(
  deps: InlineRouterDeps,
  api: Bot<Context>["api"],
  text: string,
  onFailureNotice: (notice: string) => void,
  files: GuestFileInput[] = [],
  hasRealText = true,
  existingSession: InlineSession | null = null,
  runKey: string = GLOBAL_RUN_KEY,
): Promise<{ sessionId: string; directory: string; startedAt: number; runKey: string } | null> {
  const project = getCurrentProject();
  if (!project) {
    onFailureNotice(t("inline.no_project"));
    return null;
  }
  if (isInlineRunInFlight(runKey)) {
    onFailureNotice(t("bot.session_busy"));
    return null;
  }

  const inlineSession =
    existingSession ??
    (await createInlineSession(project.worktree, text).catch(() => null));
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
  const { prependText, fileParts, videoUnsupported } = await prepareGuestFiles(
    api,
    { providerID: inlineModel.providerID, modelID: inlineModel.modelID },
    files,
  );
  if (!hasRealText && fileParts.length === 0 && !prependText.trim()) {
    onFailureNotice(videoUnsupported ? t("bot.video_unsupported") : t("error.generic"));
    return null;
  }
  const notedText = withAgentContext(prependText ? `${prependText}${text}` : text, undefined, {
    github: false,
  });
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
  setInlineRunInFlight(true, runKey);
  safeBackgroundTask({
    taskName: "session.promptAsync.inline",
    task: () => opencodeClient.session.promptAsync(promptOptions),
    onSuccess: ({ error }) => {
      if (error) {
        setInlineRunInFlight(false, runKey);
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
      setInlineRunInFlight(false, runKey);
      logger.error("[Bot] inline promptAsync background task failed", runContext);
      logger.error("[Bot] inline promptAsync background failure details:", formatErrorDetails(error, 6000));
      onFailureNotice(t("bot.prompt_send_error"));
    },
  });

  return { sessionId: inlineSession.id, directory: inlineSession.directory, startedAt, runKey };
}

const INLINE_RICH_BUDGET_CHARS = 30000;

/**
 * Posts a guest model question as a real table plus one button row per
 * option (a single row of buttons is unreadable). Tapping a button and
 * replying with the number share the same pending entry with atomic
 * claiming, so whichever arrives first wins. Falls back to the numbered
 * text table when rich edits fail.
 */
async function editGuestQuestionMessage(
  api: Bot<Context>["api"],
  inlineMessageId: string,
  question: InteractiveQuestion,
  chatId: number,
  hint: string,
): Promise<void> {
  try {
    await api.editMessageTextInline(inlineMessageId, {
      blocks: buildGuestQuestionBlocks(question, chatId),
    });
    return;
  } catch (error) {
    logger.debug("[Bot] Guest question rich edit failed, retrying as text", error);
  }
  await editInlineMessage(
    api,
    inlineMessageId,
    "",
    renderGuestQuestionTable(question, hint),
    false,
  );
}

/**
 * Replaces the guest placeholder with the run's first produced file (if any).
 * Files never reach the group otherwise: guest runs poll instead of using
 * the live pipeline, and inline edits cannot upload — only reference an
 * existing file_id. No-op when the run produced nothing or no DM chat exists
 * to stage the upload through.
 */
async function deliverGuestRunFiles(
  api: Bot<Context>["api"],
  inlineMessageId: string,
  sessionId: string,
  directory: string,
  startedAt: number,
  answerText: string,
): Promise<void> {
  const uploadChatId = getPromptChatId();
  if (!uploadChatId) {
    return;
  }
  const files = await collectRunFiles(sessionId, directory, startedAt).catch(() => []);
  if (files.length === 0) {
    return;
  }
  await deliverFirstRunFileAsInlineMedia(api, uploadChatId, inlineMessageId, files, answerText);
}

async function editInlineMessage(  api: Bot<Context>["api"],
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

/**
 * Streams the run result into the chosen inline message in place, so the
 * answer lands in the same chat without adding the bot anywhere.
 * Aborted/errored runs end the placeholder with an interruption note
 * instead of leaving it stuck.
 *
 * Pass `guest` to enable numbered question answering for guest chats: model
 * questions are posted as a numbered table and the caller replies with just
 * the option number. Inline taps keep fail-fast (no reply channel there).
 */
async function streamInlineAnswer(
  api: Bot<Context>["api"],
  inlineMessageId: string,
  sessionId: string,
  directory: string,
  startedAt: number,
  query: string,
  includeQuestion = true,
  guest: { chatId: number } | null = null,
): Promise<void> {
  logger.info(`[Bot] Streaming inline answer: session=${sessionId}`);
  const generationAtStart = currentInlineRunGeneration();
  const result = await waitForAssistantCompletion({
    sessionId,
    directory,
    startedAt,
    // Runs that cannot be answered interactively fail fast with a clear
    // notice instead of holding the run flag until timeout.
    failFastOnInteractive: true,
    shouldAbort: () => currentInlineRunGeneration() !== generationAtStart,
    onProgress: async (text) =>
      editInlineMessage(api, inlineMessageId, query, text, includeQuestion),
    ...(guest
      ? {
          onInteractiveQuestion: async (request: {
            id: string;
            questions: InteractiveQuestion[];
          }) => {
            const first = request.questions[0];
            if (!first) {
              return;
            }
            setPendingGuestQuestion(guest.chatId, {
              sessionId,
              directory,
              requestId: request.id,
              question: first.question,
              options: first.options,
              inlineMessageId,
              expiresAt: Date.now() + GUEST_QUESTION_REPLY_TIMEOUT_MS,
            });
            await editGuestQuestionMessage(
              api,
              inlineMessageId,
              first,
              guest.chatId,
              t("guest.question.reply_hint"),
            );
          },
        }
      : {}),
  });
  if (result?.completed) {
    logger.info(`[Bot] Inline answer delivered: session=${sessionId}`);
    if (guest) {
      await deliverGuestRunFiles(api, inlineMessageId, sessionId, directory, startedAt, result.text);
    }
    return;
  }
  if (result?.blocked) {
    await editInlineMessage(
      api,
      inlineMessageId,
      query,
      t(
        result.blocked === "question"
          ? "task.run.error.interactive_question"
          : "task.run.error.interactive_permission",
      ),
      includeQuestion,
    );
    return;
  }
  if (!result) {
    await editInlineMessage(api, inlineMessageId, query, t("inline.interrupted"), includeQuestion);
  }
}

export function registerInlineRouter(bot: Bot<Context>, deps: InlineRouterDeps): void {
  // NOTE: Telegram inline mode (@bot query) was removed; guest mode replaces
  // it. Only guest_message is registered below. The shared run pipeline
  // (runInlinePrompt, streamInlineAnswer, editInlineMessage) stays because
  // guest runs and user lanes use it.
  bot.on("guest_message", async (ctx) => {
    const guest = ctx.guestMessage;
    // The summoner arrives as guest_bot_caller_user, or for direct summons
    // as the message sender itself.
    const callerId = guest?.guest_bot_caller_user?.id ?? guest?.from?.id;
    // Authoritative check: the summoner must be whitelisted (auth middleware
    // already passed on sender-or-caller).
    if (!guest || !isAllowedUser(callerId)) {
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
    const video = extractGuestVideo(guest);
    if (video) {
      files.push({
        kind: "document",
        fileId: video.fileId,
        fileSize: video.fileSize,
        mime: video.mime,
        filename: video.filename,
      });
    }
    if (!text && files.length === 0) {
      logger.info(`[Bot] Ignoring guest message without text or files: caller=${callerId}`);
      return;
    }
    const chatId = typeof guest.chat?.id === "number" ? guest.chat.id : null;
    // A bare number while this chat has a pending model question answers it
    // instead of starting a new run (matched by chat: guest answers expose no
    // chat message id to match replies against).
    if (chatId !== null) {
      const handled = await tryAnswerPendingGuestQuestion(bot.api, chatId, text);
      if (handled) {
        return;
      }
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
      // One persistent session per guest chat: consecutive summons in the same
      // group share conversational memory. Falls back to a fresh session when
      // the chat id is missing or no session could be established.
      // Chats run independently: the concurrency key is per chat, so two
      // groups asking at once no longer block each other.
      const project = getCurrentProject();
      const runKey = guestRunKey(chatId);
      let existingSession: InlineSession | null = null;
      if (chatId !== null && project) {
        existingSession = await resolveGuestChatSession(chatId, project.worktree);
      }
      const run = await runInlinePrompt(
        deps,
        bot.api,
        promptText,
        notifyGuest,
        files,
        ownText.trim().length > 0,
        existingSession,
        runKey,
      );
      if (run) {
        if (chatId !== null && existingSession) {
          touchGuestChatSession(chatId);
        }
        void streamInlineAnswer(
          bot.api,
          inlineMessageId,
          run.sessionId,
          run.directory,
          run.startedAt,
          question,
          false,
          chatId !== null ? { chatId } : null,
        ).finally(() => {
          if (chatId !== null) {
            clearPendingGuestQuestion(chatId);
          }
          setInlineRunInFlight(false, run.runKey);
        });
      }
    } catch (err) {
      logger.error("[Bot] Error running guest prompt:", err);
      notifyGuest(t("error.generic"));
    }
  });
}
