import type { Api, RawApi } from "grammy";
import {
  downloadTelegramFile,
  isTextMimeType,
  toDataUri,
} from "../../app/services/file-download-service.js";
import {
  extractDocument,
  isDocExtractorConfigured,
} from "../../app/services/document-extractor-service.js";
import {
  getModelCapabilities,
  supportsInput,
} from "../../app/services/model-capabilities-service.js";
import { isSttConfigured, transcribeAudio } from "../../app/services/stt-service.js";
import { logger } from "../../utils/logger.js";
import type { FilePartInput } from "@opencode-ai/sdk/v2";

/** Guest/inline attachments cap: everything above is skipped. */
export const GUEST_FILE_MAX_BYTES = 10 * 1024 * 1024;

import type {
  GuestDocumentInput,
  GuestPhotoInput,
  GuestVoiceInput,
} from "./inline-results.js";

/** Union of every attachment prepareGuestFiles accepts. */
export type GuestFileInput =
  | ({ kind: "photo" } & GuestPhotoInput)
  | ({ kind: "document" } & GuestDocumentInput)
  | ({ kind: "voice" } & GuestVoiceInput & { filename?: string | undefined });

export interface GuestFilesResult {
  /** Extracted/transcribed text to prepend to the prompt. */
  prependText: string;
  fileParts: FilePartInput[];
}

const DOCUMENT_MIME_TYPES = [
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.oasis.opendocument.text",
  "application/vnd.oasis.opendocument.presentation",
  "application/vnd.oasis.opendocument.spreadsheet",
  "text/rtf",
];

function isTooBig(fileSize: number | undefined): boolean {
  return typeof fileSize === "number" && fileSize > GUEST_FILE_MAX_BYTES;
}

function wrapFileContent(filename: string, content: string): string {
  return `--- Content of ${filename} ---\n${content}\n--- End of file ---\n\n`;
}

/**
 * Downloads guest attachments (photos, documents, voice) and converts them
 * into prompt text and file parts, mirroring the DM pipeline rules:
 * images and office docs go native when the model supports them, text is
 * inlined, voice is transcribed. Anything unsupported or oversized is
 * skipped with a log line instead of failing the whole prompt.
 */
export async function prepareGuestFiles(
  api: Api<RawApi>,
  model: { providerID: string; modelID: string },
  files: GuestFileInput[],
): Promise<GuestFilesResult> {
  const texts: string[] = [];
  const fileParts: FilePartInput[] = [];
  const capabilities = await getModelCapabilities(model.providerID, model.modelID).catch(
    () => null,
  );

  for (const file of files) {
    if (isTooBig(file.fileSize)) {
      logger.warn(`[GuestFiles] Skipping oversized file: bytes=${file.fileSize}`);
      continue;
    }

    try {
      if (file.kind === "voice") {
        if (!isSttConfigured()) {
          logger.warn("[GuestFiles] Voice skipped: STT is not configured");
          continue;
        }
        const downloaded = await downloadTelegramFile(api, file.fileId);
        const result = await transcribeAudio(
          downloaded.buffer,
          file.filename || "voice.ogg",
        );
        if (result.text.trim()) {
          texts.push(result.text.trim());
        }
        continue;
      }
      const filename =
        ("filename" in file && file.filename) ||
        (file.kind === "photo" ? "photo.jpg" : "document");
      const mime =
        ("mime" in file && file.mime) || (file.kind === "photo" ? "image/jpeg" : "");

      if (isTextMimeType(mime, filename)) {
        const downloaded = await downloadTelegramFile(api, file.fileId);
        const content = downloaded.buffer.toString("utf-8").trim();
        if (content) {
          texts.push(wrapFileContent(filename, content).trim());
        }
        continue;
      }

      if (mime.startsWith("image/") || file.kind === "photo") {
        if (!supportsInput(capabilities, "image")) {
          logger.warn("[GuestFiles] Model doesn't support image input, skipping photo");
          continue;
        }
        const downloaded = await downloadTelegramFile(api, file.fileId);
        fileParts.push({
          type: "file",
          mime: mime.startsWith("image/") ? mime : "image/jpeg",
          filename,
          url: toDataUri(downloaded.buffer, mime.startsWith("image/") ? mime : "image/jpeg"),
        });
        continue;
      }

      if (mime.startsWith("video/")) {
        if (!supportsInput(capabilities, "video")) {
          logger.warn("[GuestFiles] Model doesn't support video input, skipping");
          continue;
        }
        const downloaded = await downloadTelegramFile(api, file.fileId);
        fileParts.push({
          type: "file",
          mime,
          filename,
          url: toDataUri(downloaded.buffer, mime),
        });
        continue;
      }

      if (DOCUMENT_MIME_TYPES.includes(mime)) {
        if (supportsInput(capabilities, "pdf")) {
          const downloaded = await downloadTelegramFile(api, file.fileId);
          fileParts.push({
            type: "file",
            mime,
            filename,
            url: toDataUri(downloaded.buffer, mime),
          });
        } else if (isDocExtractorConfigured()) {
          const downloaded = await downloadTelegramFile(api, file.fileId);
          const result = await extractDocument(downloaded.buffer, mime, filename);
          if (result.text.trim()) {
            texts.push(wrapFileContent(filename, result.text.trim()).trim());
          }
        } else {
          logger.warn("[GuestFiles] Model doesn't support documents and no extractor is set");
        }
        continue;
      }

      logger.warn(`[GuestFiles] Unsupported file type: mime=${mime}, filename=${filename}`);
    } catch (error) {
      logger.warn("[GuestFiles] Failed to prepare attachment, skipping:", error);
    }
  }

  return { prependText: texts.join("\n\n"), fileParts };
}
