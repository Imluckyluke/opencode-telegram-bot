import { config } from "../../config.js";
import { logger } from "../../utils/logger.js";

const REQUEST_TIMEOUT_MS = 60_000;

export interface DocExtractorResult {
  text: string;
}

export function isDocExtractorConfigured(): boolean {
  return Boolean(config.docExtractor.apiUrl);
}

function pickTextField(data: unknown): string | null {
  if (typeof data === "string") {
    return data;
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return null;
  }
  const record = data as Record<string, unknown>;
  for (const key of ["text", "content", "markdown", "data"]) {
    const value = record[key];
    if (typeof value === "string") {
      return value;
    }
  }
  return null;
}

export async function extractDocument(
  fileBuffer: Buffer,
  mimeType: string,
  filename: string,
): Promise<DocExtractorResult> {
  if (!isDocExtractorConfigured()) {
    throw new Error(
      "Document extractor is not configured: DOC_EXTRACTOR_URL is required",
    );
  }

  const url = config.docExtractor.apiUrl!;

  const formData = new FormData();
  formData.append("file", new Blob([new Uint8Array(fileBuffer)], { type: mimeType }), filename);

  logger.debug(
    `[DocExtractor] Sending extraction request: url=${url}, mime=${mimeType}, filename=${filename}, size=${fileBuffer.length} bytes`,
  );

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const headers: Record<string, string> = {};
    if (config.docExtractor.apiKey) {
      headers["Authorization"] = `Bearer ${config.docExtractor.apiKey}`;
    }

    const response = await fetch(url, {
      method: "POST",
      headers,
      body: formData,
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => "");
      throw new Error(
        `Document extractor API returned HTTP ${response.status}: ${errorBody || response.statusText}`,
      );
    }

    const rawBody = await response.text().catch(() => "");
    const contentType = response.headers?.get("content-type") ?? "";
    let text: string | null = null;
    try {
      text = pickTextField(JSON.parse(rawBody));
    } catch {
      // Not JSON: accept a plain-text body, but never an HTML error page.
      if (contentType.startsWith("text/") && !contentType.includes("html")) {
        text = rawBody.trim() || null;
      }
    }

    if (typeof text !== "string" || !text) {
      throw new Error("Document extractor API response does not contain a text field");
    }

    // Char budget (same scale as text-file attachments): protects every
    // caller — the guest path has no caller-side cap — from stuffing
    // megabytes of extracted text into one prompt.
    const budgetChars = config.files.maxFileSizeKb * 1024;
    if (text.length > budgetChars) {
      logger.warn(
        `[DocExtractor] Extracted text exceeds budget: ${text.length} chars > ${budgetChars}`,
      );
      throw new Error(
        `Document extractor returned too much text: ${text.length} chars (max ${budgetChars})`,
      );
    }

    return { text };
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      throw new Error(`Document extractor request timed out after ${REQUEST_TIMEOUT_MS}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}
