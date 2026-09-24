import { InputFile } from "grammy";
import type { Bot, Context } from "grammy";
import { opencodeClient } from "../../opencode/client.js";
import {
  buildToolFileData,
  type CodeFileData,
} from "../../app/formatters/summary-formatter.js";
import { logger } from "../../utils/logger.js";

const MAX_COLLECTED_RUN_FILES = 10;
const INLINE_MEDIA_CAPTION_LIMIT = 1024;

interface ToolPartLike {
  type?: unknown;
  tool?: unknown;
  title?: unknown;
  state?: {
    status?: unknown;
    input?: unknown;
    metadata?: unknown;
  } | null;
}

interface SessionMessageLike {
  info?: {
    time?: {
      created?: unknown;
    };
  };
  parts?: unknown;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Reconstructs the downloadable files of a finished run by polling session
 * messages (guest/user lanes never see the live SSE tool pipeline, so this
 * is their only source). Returns completed write/edit/apply_patch outputs as
 * Telegram-ready documents, oldest first.
 */
export async function collectRunFiles(
  sessionId: string,
  directory: string,
  since: number,
): Promise<CodeFileData[]> {
  const { data, error } = await opencodeClient.session.messages({
    sessionID: sessionId,
    directory,
  });
  if (error || !data) {
    return [];
  }

  const files: CodeFileData[] = [];
  const messages = Array.isArray(data) ? (data as SessionMessageLike[]) : [];
  for (const message of messages) {
    const created = message?.info?.time?.created;
    if (typeof created === "number" && created < since) {
      continue;
    }
    const parts = Array.isArray(message?.parts) ? (message.parts as ToolPartLike[]) : [];
    for (const part of parts) {
      if (part?.type !== "tool" || typeof part.tool !== "string") {
        continue;
      }
      if (part.state?.status !== "completed") {
        continue;
      }
      const input = asRecord(part.state.input) ?? undefined;
      const metadata = asRecord(part.state.metadata) ?? undefined;
      const title = typeof part.title === "string" ? part.title : undefined;
      const fileData = buildToolFileData(part.tool, input, title, metadata);
      if (fileData) {
        files.push(fileData);
      }
      if (files.length >= MAX_COLLECTED_RUN_FILES) {
        return files;
      }
    }
  }

  return files;
}

function buildInlineMediaCaption(summaryText: string, files: CodeFileData[]): string {
  const [first, ...rest] = files;
  let caption = summaryText.trim() || first?.filename || "";
  caption = caption.slice(0, INLINE_MEDIA_CAPTION_LIMIT);
  if (rest.length > 0) {
    const more = `(+${rest.length} more: ${rest.map((file) => file.filename).join(", ")})`;
    caption = `${caption.slice(0, INLINE_MEDIA_CAPTION_LIMIT - more.length - 1)}\n${more}`.trim();
  }
  return caption;
}

/**
 * Delivers a finished run's first file into a guest placeholder message.
 * Telegram accepts only a file_id (or URL) for inline media edits — never a
 * fresh upload — so the file is uploaded once via sendDocument to a real
 * chat, then the placeholder is replaced in place with editMessageMedia. The
 * upload message is deleted right away (the file_id stays valid), keeping
 * the origin chat clean.
 *
 * Returns true when the placeholder now shows the document.
 */
export async function deliverFirstRunFileAsInlineMedia(
  api: Bot<Context>["api"],
  uploadChatId: number,
  inlineMessageId: string,
  files: CodeFileData[],
  summaryText: string,
): Promise<boolean> {
  const [first, ...rest] = files;
  if (!first) {
    return false;
  }

  try {
    const sent = await api.sendDocument(
      uploadChatId,
      new InputFile(first.buffer, first.filename),
      { disable_notification: true },
    );
    const fileId = sent?.document?.file_id;
    if (!fileId) {
      return false;
    }
    await api.deleteMessage(uploadChatId, sent.message_id).catch(() => {});

    const caption = buildInlineMediaCaption(summaryText, files);
    await api.editMessageMediaInline(inlineMessageId, {
      type: "document",
      media: fileId,
      ...(caption ? { caption } : {}),
    });
    logger.info(
      `[GuestFiles] Delivered run file in place: file=${first.filename}, extra=${rest.length}`,
    );
    return true;
  } catch (error) {
    logger.warn("[GuestFiles] Failed to deliver run file in place:", error);
    return false;
  }
}
