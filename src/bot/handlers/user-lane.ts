import type { Context } from "grammy";
import { InputFile } from "grammy";
import { opencodeClient } from "../../opencode/client.js";
import {
  clearUserSession,
  getCurrentProject,
  getUserSession,
  setUserSession,
} from "../../app/stores/settings-store.js";
import type { SessionInfo } from "../../app/types/session.js";
import { ingestSessionInfoForCache } from "../../app/services/session-cache-service.js";
import { getStoredAgent, resolveProjectAgent } from "../../app/services/agent-selection-service.js";
import { getStoredInlineModel } from "../../app/services/model-selection-service.js";
import { backgroundSessionTracker } from "../../app/managers/background-session-manager.js";
import { withAgentContext } from "../../app/services/agent-context-service.js";
import { prepareGuestFiles, type GuestFileInput } from "../inline/guest-files.js";
import { downloadTelegramFile } from "../../app/services/file-download-service.js";
import {
  extractGuestDocument,
  extractGuestPhoto,
  extractGuestReplyText,
  extractGuestVideo,
  extractGuestVoice,
  guestVoiceFilename,
  stripBotMention,
} from "../inline/inline-results.js";
import { renderAssistantFinalPartsSafe } from "../messages/assistant-rendering.js";
import { truncateTextSafe } from "../render/text-splitter.js";
import {
  sendRenderedBotPart,
} from "../messages/telegram-text.js";
import { isSttConfigured, transcribeAudio } from "../../app/services/stt-service.js";
import { safeBackgroundTask } from "../../utils/safe-background-task.js";
import { formatErrorDetails } from "../../utils/error-format.js";
import { logger } from "../../utils/logger.js";
import { t } from "../../i18n/index.js";
import { isSessionBusy } from "./prompt.js";
import { waitForAssistantCompletion } from "../inline/run-waiter.js";
import { collectRunFiles } from "../inline/guest-run-files.js";

const USER_SESSION_TITLE_PREFIX = "Chat ";
const USER_LANE_TEXT_LIMIT = 4000;

const userLaneInFlight = new Set<number>();

/**
 * Content kinds a granted (non-owner) user may send. Everything else
 * (commands, callbacks, inline, guest) is denied by the tier guard.
 */
export function isUserLaneContent(ctx: Context): boolean {
  const message = ctx.message;
  if (!message) {
    return false;
  }
  const text = message.text ?? message.caption ?? "";
  if (typeof text === "string" && text.trim() && !text.trim().startsWith("/")) {
    return true;
  }
  return Boolean(
    message.voice ?? message.audio ?? message.photo?.length ?? message.document ?? message.video ?? message.animation,
  );
}

interface LaneAttachment {
  files: GuestFileInput[];
  voiceFileId?: string | undefined;
  voiceFilename?: string | undefined;
}

function collectLaneAttachments(message: NonNullable<Context["message"]>): LaneAttachment {
  const files: GuestFileInput[] = [];
  const photo = extractGuestPhoto(message);
  if (photo) {
    files.push({ kind: "photo", fileId: photo.fileId, fileSize: photo.fileSize });
  }
  const document = extractGuestDocument(message);
  if (document) {
    files.push({
      kind: "document",
      fileId: document.fileId,
      fileSize: document.fileSize,
      mime: document.mime,
      filename: document.filename,
    });
  }
  const video = extractGuestVideo(message);
  if (video) {
    files.push({
      kind: "document",
      fileId: video.fileId,
      fileSize: video.fileSize,
      mime: video.mime,
      filename: video.filename,
    });
  }
  const voice = extractGuestVoice(message);
  if (voice) {
    return {
      files,
      voiceFileId: voice.fileId,
      voiceFilename: guestVoiceFilename(voice.mime),
    };
  }
  return { files };
}

async function transcribeLaneVoice(
  api: Context["api"],
  fileId: string,
  filename: string,
): Promise<string | null> {
  if (!isSttConfigured()) {
    return null;
  }
  try {
    const downloaded = await downloadTelegramFile(api, fileId);
    const result = await transcribeAudio(downloaded.buffer, filename);
    return result.text.trim() || null;
  } catch (error) {
    logger.warn("[UserLane] Voice transcription failed:", error);
    return null;
  }
}

async function getOrCreateUserSession(
  userId: number,
  directory: string,
  label: string,
): Promise<SessionInfo | null> {
  const mapped = getUserSession(userId);
  if (mapped && mapped.directory === directory) {
    try {
      const { error } = await opencodeClient.session.get({
        sessionID: mapped.id,
        directory,
      });
      if (!error) {
        return mapped;
      }
      const message = error instanceof Error ? error.message : String(error ?? "");
      if (!message.includes("Session not found")) {
        // Transient failure (network, auth, …): keep the stored session
        // instead of spamming fresh sessions on every message.
        logger.debug(`[UserLane] Could not verify user session, keeping it: user=${userId}`);
        return mapped;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error ?? "");
      if (!message.includes("Session not found")) {
        logger.debug(`[UserLane] Could not verify user session, keeping it: user=${userId}`);
        return mapped;
      }
      // Fall through to recreate below.
    }
    logger.warn(`[UserLane] Stored user session is gone, recreating: user=${userId}`);
    clearUserSession(userId);
  }
  const { data, error } = await opencodeClient.session.create({ directory });
  if (error || !data?.id) {
    return null;
  }
  const session: SessionInfo = {
    id: data.id,
    title: `${USER_SESSION_TITLE_PREFIX}${label}`,
    directory,
  };
  await opencodeClient.session
    .update({ sessionID: data.id, directory, title: session.title })
    .catch(() => {});
  await ingestSessionInfoForCache(data).catch(() => {});
  setUserSession(userId, session);
  return session;
}

/**
 * Runs one prompt for a granted user inside their personal session and
 * delivers the answer back to their own chat. Never touches shared state
 * (current session, keyboard, pinned dashboard, foreground busy flags).
 */
export async function processUserLaneMessage(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  const chatId = ctx.chat?.id;
  const message = ctx.message;
  if (typeof userId !== "number" || typeof chatId !== "number" || !message) {
    return;
  }
  // Private chats only: chat id must equal the user id.
  if (chatId !== userId) {
    logger.debug(`[UserLane] Ignoring non-DM lane message: chat=${chatId}`);
    return;
  }

  const project = getCurrentProject();
  if (!project) {
    await ctx.reply(t("inline.no_project")).catch(() => {});
    return;
  }
  if (userLaneInFlight.has(userId)) {
    await ctx.reply(t("bot.session_busy")).catch(() => {});
    return;
  }

  const rawText = (message.text ?? message.caption ?? "").trim().slice(0, USER_LANE_TEXT_LIMIT);
  const username = ctx.me?.username ?? null;
  const ownText = stripBotMention(rawText, username);
  const replyText = extractGuestReplyText(message);
  const { files, voiceFileId, voiceFilename } = collectLaneAttachments(message);

  let transcribed: string | null = null;
  if (voiceFileId) {
    transcribed = await transcribeLaneVoice(ctx.api, voiceFileId, voiceFilename ?? "voice.ogg");
    if (!transcribed) {
      await ctx.reply(t("stt.not_configured")).catch(() => {});
      return;
    }
  }

  const questionBody = [transcribed, ownText].filter(Boolean).join("\n");
  const promptText = replyText ? `> ${replyText}\n\n${questionBody}` : questionBody;
  const displayQuestion =
    questionBody || (files.length === 1 ? "See attached file" : "See attached files");
  if (!promptText.trim() && files.length === 0) {
    return;
  }

  const session = await getOrCreateUserSession(
    userId,
    project.worktree,
    String(ctx.from?.first_name ?? userId),
  ).catch(() => null);
  if (!session) {
    await ctx.reply(t("bot.create_session_error")).catch(() => {});
    return;
  }

  backgroundSessionTracker.setMuted(session.id, true);
  if (await isSessionBusy(session.id, session.directory)) {
    await ctx.reply(t("bot.session_busy")).catch(() => {});
    return;
  }

  const currentAgent = await resolveProjectAgent(getStoredAgent());
  const inlineModel = getStoredInlineModel();
  const { prependText, fileParts } = await prepareGuestFiles(
    ctx.api,
    { providerID: inlineModel.providerID, modelID: inlineModel.modelID },
    files,
  );
  const notedText = withAgentContext(
    prependText ? `${prependText}${promptText}` : promptText,
    undefined,
    { github: false },
  );

  const placeholder = await ctx
    .reply(t("inline.posted.text", { query: displayQuestion.slice(0, 200) }))
    .catch(() => null);
  if (!placeholder) {
    return;
  }

  const runContext = { sessionId: session.id, userId, promptLength: notedText.length };
  const startedAt = Date.now();
  userLaneInFlight.add(userId);
  safeBackgroundTask({
    taskName: "session.promptAsync.userlane",
    task: () =>
      opencodeClient.session.promptAsync({
        sessionID: session.id,
        directory: session.directory,
        parts: [{ type: "text", text: notedText }, ...fileParts],
        model: { providerID: inlineModel.providerID, modelID: inlineModel.modelID },
        ...(inlineModel.variant ? { variant: inlineModel.variant } : {}),
        agent: currentAgent,
      }),
    onSuccess: ({ error }) => {
      if (error) {
        userLaneInFlight.delete(userId);
        logger.error("[Bot] OpenCode API returned an error for user lane prompt", runContext);
        void ctx.api
          .editMessageText(chatId, placeholder.message_id, t("bot.prompt_send_error"))
          .catch(() => {});
      }
    },
    onError: (error) => {
      userLaneInFlight.delete(userId);
      logger.error("[Bot] user lane promptAsync background task failed", runContext);
      logger.error("[Bot] user lane promptAsync failure details:", formatErrorDetails(error, 6000));
      void ctx.api
        .editMessageText(chatId, placeholder.message_id, t("bot.prompt_send_error"))
        .catch(() => {});
    },
  });

  const renderFinal = async (text: string): Promise<void> => {
    const parts = renderAssistantFinalPartsSafe(text);
    await ctx.api.deleteMessage(chatId, placeholder.message_id).catch(() => {});
    for (const part of parts) {
      await sendRenderedBotPart({ api: ctx.api, chatId, part }).catch((error: unknown) => {
        logger.warn("[UserLane] Failed to deliver part:", error);
      });
    }
  };

  void waitForAssistantCompletion({
    sessionId: session.id,
    directory: session.directory,
    startedAt,
    onProgress: async (text) => {
      await ctx.api
        .editMessageText(chatId, placeholder.message_id, truncateTextSafe(text, 4000))
        .catch(() => {});
      return true;
    },
  })
    .then(async (result) => {
      // Polling lanes never see live tool file outputs: reconstruct them from
      // the finished run so produced files arrive as real documents.
      const files = result
        ? await collectRunFiles(session.id, session.directory, startedAt).catch(() => [])
        : [];
      for (const file of files) {
        await ctx.api
          .sendDocument(chatId, new InputFile(file.buffer, file.filename), {
            disable_notification: true,
          })
          .catch((error: unknown) => {
            logger.warn("[UserLane] Failed to deliver file:", error);
          });
      }
      if (result?.text) {
        await renderFinal(result.text);
      } else if (files.length === 0) {
        await ctx.api
          .editMessageText(chatId, placeholder.message_id, t("inline.interrupted"))
          .catch(() => {});
      }
    })
    .catch((error: unknown) => {
      logger.error("[Bot] user lane streaming failed:", error);
    })
    .finally(() => {
      userLaneInFlight.delete(userId);
    });
}
