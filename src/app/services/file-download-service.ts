import nodeFetch, { type RequestInit as NodeFetchRequestInit } from "node-fetch";
import type { Api } from "grammy";
import { Agent as HttpsAgent } from "https";
import { config } from "../../config.js";
import { logger } from "../../utils/logger.js";

export const MAX_FILE_SIZE_BYTES = 20 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 300_000;
const DEFAULT_TELEGRAM_API_ROOT = "https://api.telegram.org";

export interface DownloadedFile {
  buffer: Buffer;
  filePath: string;
  mimeType?: string;
}

function telegramFileUrlBase(): string {
  const apiRoot = config.telegram.apiRoot
    ? config.telegram.apiRoot.replace(/\/+$/, "")
    : DEFAULT_TELEGRAM_API_ROOT;

  return `${apiRoot}/file/bot`;
}

export function buildTelegramFileUrl(filePath: string): string {
  return `${telegramFileUrlBase()}${config.telegram.token}/${filePath}`;
}

export async function downloadTelegramFile(api: Api, fileId: string): Promise<DownloadedFile> {
  logger.debug(`[FileDownload] Getting file info for fileId=${fileId}`);

  const file = await api.getFile(fileId);

  if (!file.file_path) {
    throw new Error("File path not available from Telegram");
  }

  if (file.file_size && file.file_size > MAX_FILE_SIZE_BYTES) {
    const sizeMb = (file.file_size / (1024 * 1024)).toFixed(2);
    throw new Error(`File too large: ${sizeMb}MB (max 20MB)`);
  }

  const fileUrl = buildTelegramFileUrl(file.file_path);
  const redactedUrl =
    config.telegram.token.length > 0 ? fileUrl.replace(config.telegram.token, "***") : fileUrl;
  logger.debug(`[FileDownload] Downloading from ${redactedUrl}`);

  const fetchOptions: NodeFetchRequestInit = {};

  if (config.telegram.proxyUrl) {
    const proxyUrl = config.telegram.proxyUrl;
    if (proxyUrl.startsWith("socks")) {
      const { SocksProxyAgent } = await import("socks-proxy-agent");
      fetchOptions.agent = new SocksProxyAgent(proxyUrl);
    } else {
      const { HttpsProxyAgent } = await import("https-proxy-agent");
      fetchOptions.agent = new HttpsProxyAgent(proxyUrl);
    }
  } else if (config.telegram.forceIpv4) {
    fetchOptions.agent = new HttpsAgent({ family: 4, keepAlive: true });
  }

  if (config.telegram.proxySecret) {
    fetchOptions.headers = {
      ...(fetchOptions.headers as Record<string, string> | undefined),
      "X-Proxy-Secret": config.telegram.proxySecret,
    };
  }

  const response = await nodeFetch(fileUrl, { ...fetchOptions, timeout: DOWNLOAD_TIMEOUT_MS });

  if (!response.ok) {
    throw new Error(`Failed to download file: ${response.status} ${response.statusText}`);
  }

  // Belt and suspenders: the metadata check above trusts Telegram, so enforce
  // the cap again on the wire — declared length up front, actual bytes while
  // streaming — instead of buffering an unbounded body into memory.
  const declaredLength = response.headers?.get("content-length") ?? null;
  if (declaredLength !== null) {
    const declaredBytes = Number.parseInt(declaredLength, 10);
    if (Number.isInteger(declaredBytes) && declaredBytes > MAX_FILE_SIZE_BYTES) {
      throw new Error(
        `File too large: ${(declaredBytes / (1024 * 1024)).toFixed(2)}MB (max 20MB)`,
      );
    }
  }

  const buffer = await readCappedBody(response);
  logger.debug(`[FileDownload] Downloaded ${buffer.length} bytes`);

  return {
    buffer,
    filePath: file.file_path,
  };
}

/**
 * Reads a node-fetch body while enforcing MAX_FILE_SIZE_BYTES. A lying or
 * missing Content-Length cannot OOM the process: the stream is destroyed as
 * soon as the cap is exceeded.
 */
async function readCappedBody(response: Awaited<ReturnType<typeof nodeFetch>>): Promise<Buffer> {
  // node-fetch v2 streams Node readable bodies at runtime; the static type is
  // the web-stream shape, so narrow to the surface actually used.
  const body = response.body as unknown as {
    on(event: "data", listener: (chunk: Buffer) => void): unknown;
    on(event: "end", listener: () => void): unknown;
    on(event: "error", listener: (error: Error) => void): unknown;
    destroy?: () => void;
  } | null;

  if (!body) {
    const fallback = Buffer.from(await response.arrayBuffer());
    if (fallback.length > MAX_FILE_SIZE_BYTES) {
      throw new Error(
        `File too large: ${(fallback.length / (1024 * 1024)).toFixed(2)}MB (max 20MB)`,
      );
    }
    return fallback;
  }

  const chunks: Buffer[] = [];
  let receivedBytes = 0;

  await new Promise<void>((resolve, reject) => {
    body.on("data", (chunk: Buffer) => {
      receivedBytes += chunk.length;
      if (receivedBytes > MAX_FILE_SIZE_BYTES) {
        reject(new Error(`File too large: exceeds 20MB during download`));
        body.destroy?.();
        return;
      }
      chunks.push(chunk);
    });
    body.on("end", () => resolve());
    body.on("error", (error: Error) => reject(error));
  });

  return Buffer.concat(chunks);
}

export function toDataUri(buffer: Buffer, mimeType: string): string {
  const base64 = buffer.toString("base64");
  return `data:${mimeType};base64,${base64}`;
}

export function isFileSizeAllowed(fileSize: number | undefined, maxSizeKb: number): boolean {
  if (!fileSize) {
    return true;
  }

  const maxBytes = maxSizeKb * 1024;
  return fileSize <= maxBytes;
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes}B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)}KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

const APPLICATION_TEXT_MIME_TYPES = new Set([
  "application/json",
  "application/xml",
  "application/javascript",
  "application/x-yaml",
  "application/sql",
]);

const TEXT_FILE_EXTENSIONS = new Set([
  "svelte",
  "vue",
  "ts",
  "tsx",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "json",
  "txt",
  "xml",
  "csv",
  "tsv",
  "sql",
  "env",
  "lock",
  "conf",
  "properties",
  "tf",
  "go",
  "rs",
  "rb",
  "py",
  "java",
  "c",
  "cpp",
  "h",
  "hpp",
  "cs",
  "swift",
  "kt",
  "kts",
  "sh",
  "bash",
  "yaml",
  "yml",
  "toml",
  "ini",
  "cfg",
  "md",
  "mdx",
  "css",
  "scss",
  "less",
  "html",
  "htm",
  "graphql",
  "gql",
  "proto",
  "gradle",
]);

// Text files that carry no extension, plus dotfiles whose whole name is the marker.
const TEXT_FILE_NAMES = new Set([
  "makefile",
  "dockerfile",
  "license",
  "readme",
  "changelog",
  ".gitignore",
  ".dockerignore",
  ".editorconfig",
  ".env",
  ".env.example",
  ".npmrc",
  ".prettierrc",
  ".eslintrc",
]);

/**
 * Whether a local file looks like text, judging by its name alone.
 *
 * Files picked from the /ls browser carry no MIME type - Telegram only provides one for
 * uploaded documents - so `isTextMimeType` cannot be used for them.
 */
export function isTextFileName(filename: string): boolean {
  const baseName = filename.split(/[\\/]/).pop()?.toLowerCase();
  if (!baseName) {
    return false;
  }

  if (TEXT_FILE_NAMES.has(baseName)) {
    return true;
  }

  const ext = baseName.includes(".") ? baseName.split(".").pop() : undefined;
  return Boolean(ext && TEXT_FILE_EXTENSIONS.has(ext));
}

export function isTextMimeType(mimeType: string | undefined, filename?: string): boolean {
  if (!mimeType) {
    return false;
  }

  if (mimeType.startsWith("text/")) {
    return true;
  }

  if (APPLICATION_TEXT_MIME_TYPES.has(mimeType)) {
    return true;
  }

  if (filename) {
    const ext = filename.split(".").pop()?.toLowerCase();
    if (ext && TEXT_FILE_EXTENSIONS.has(ext)) {
      return true;
    }
  }

  return false;
}
