import { config } from "../../config.js";
import type { MessageFormatMode } from "../../config.js";
import { logger } from "../../utils/logger.js";
import { normalizeMarkdownForTelegramRendering } from "../render/markdown-normalizer.js";
import { convertToTelegramMarkdownV2 } from "../render/markdown-to-telegram-v2.js";

const TELEGRAM_MESSAGE_LIMIT = 4096;

interface SplitTextOptions {
  avoidTrailingMarkdownEscape?: boolean;
  /**
   * How to avoid ending a chunk inside a ``` fence (which would hand the
   * Markdown converter a half-fence chunk):
   * - "extend": continue to the fence close (used before conversion, where a
   *   later split still enforces the size limit);
   * - "shrink": back up to the fence open so the final chunk fits the limit.
   */
  fenceAware?: "extend" | "shrink";
}

function endsWithOddTrailingBackslashes(text: string, start: number, end: number): boolean {
  let backslashCount = 0;

  for (let index = end - 1; index >= start; index--) {
    if (text[index] !== "\\") {
      break;
    }
    backslashCount += 1;
  }

  return backslashCount % 2 === 1;
}

function countFenceMarkers(text: string, from: number, to: number): number {
  let count = 0;
  let index = text.indexOf("```", from);
  while (index >= 0 && index < to) {
    count += 1;
    index = text.indexOf("```", index + 3);
  }
  return count;
}

function resolveSplitEndIndex(
  text: string,
  currentIndex: number,
  maxLength: number,
  options?: SplitTextOptions,
): number {
  const hardLimit = Math.min(text.length, currentIndex + maxLength);
  if (hardLimit >= text.length) {
    return text.length;
  }

  let endIndex = hardLimit;
  const breakPoint = text.lastIndexOf("\n", endIndex);
  if (breakPoint > currentIndex) {
    endIndex = breakPoint + 1;
  }

  if (options?.fenceAware && endIndex < text.length) {
    endIndex = resolveFenceSafeEndIndex(text, currentIndex, endIndex, options.fenceAware);
  }

  if (!options?.avoidTrailingMarkdownEscape) {
    return endIndex;
  }

  while (endIndex > currentIndex && endsWithOddTrailingBackslashes(text, currentIndex, endIndex)) {
    endIndex -= 1;
  }

  return endIndex > currentIndex ? endIndex : hardLimit;
}

/**
 * Moves a chunk boundary out of an open code fence: extends to the fence
 * close (pre-conversion, where a later split still enforces the size limit)
 * or shrinks to the fence open (final split, which must fit the limit).
 */
function resolveFenceSafeEndIndex(
  text: string,
  currentIndex: number,
  endIndex: number,
  mode: "extend" | "shrink",
): number {
  if (countFenceMarkers(text, currentIndex, endIndex) % 2 === 0) {
    return endIndex;
  }

  if (mode === "extend") {
    const closeIndex = text.indexOf("```", endIndex);
    return closeIndex >= 0 ? closeIndex + 3 : endIndex;
  }

  const openIndex = text.lastIndexOf("```", endIndex - 1);
  return openIndex >= currentIndex ? openIndex : endIndex;
}

function splitText(text: string, maxLength: number, options?: SplitTextOptions): string[] {
  const parts: string[] = [];
  let currentIndex = 0;

  while (currentIndex < text.length) {
    const endIndex = resolveSplitEndIndex(text, currentIndex, maxLength, options);

    if (endIndex <= currentIndex) {
      const fallbackEnd = Math.min(text.length, currentIndex + 1);
      parts.push(text.slice(currentIndex, fallbackEnd));
      currentIndex = fallbackEnd;
      continue;
    }

    parts.push(text.slice(currentIndex, endIndex));
    currentIndex = endIndex;
  }

  return parts;
}

export function formatSummary(text: string): string[] {
  return formatSummaryWithMode(text, config.bot.messageFormatMode);
}

function formatMarkdownForTelegram(text: string): string {
  try {
    const preprocessed = normalizeMarkdownForTelegramRendering(text);
    return escapeMarkdownV2PipesOutsideCode(convertToTelegramMarkdownV2(preprocessed));
  } catch (error) {
    logger.warn("[Formatter] Failed to convert markdown summary, falling back to raw text", error);
    return text;
  }
}

function escapeMarkdownV2PipesOutsideCode(text: string): string {
  let result = "";
  let index = 0;
  let inInlineCode = false;
  let inCodeFence = false;

  while (index < text.length) {
    if (text.startsWith("```", index)) {
      result += "```";
      index += 3;
      inCodeFence = !inCodeFence;
      continue;
    }

    const char = text[index];

    if (!inCodeFence && char === "`") {
      inInlineCode = !inInlineCode;
      result += char;
      index += 1;
      continue;
    }

    if (!inCodeFence && !inInlineCode && char === "|" && text[index - 1] !== "\\") {
      result += "\\|";
      index += 1;
      continue;
    }

    result += char;
    index += 1;
  }

  return result;
}

export function formatSummaryWithMode(
  text: string,
  mode: MessageFormatMode,
  maxLength: number = TELEGRAM_MESSAGE_LIMIT,
): string[] {
  if (!text || text.trim().length === 0) {
    return [];
  }

  const normalizedMaxLength = Math.max(1, Math.floor(maxLength));
  const rawTextLimit =
    mode === "raw" ? Math.max(1, normalizedMaxLength - "```\n\n```".length) : normalizedMaxLength;
  const parts = splitText(
    text,
    rawTextLimit,
    mode === "markdown" ? { fenceAware: "extend" } : undefined,
  );
  const formattedParts: string[] = [];

  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) {
      continue;
    }

    if (mode === "markdown") {
      const converted = formatMarkdownForTelegram(trimmed);
      const convertedParts = splitText(converted, normalizedMaxLength, {
        avoidTrailingMarkdownEscape: true,
        fenceAware: "shrink",
      });

      for (const convertedPart of convertedParts) {
        const normalizedPart = convertedPart.trim();
        if (normalizedPart) {
          formattedParts.push(normalizedPart);
        }
      }
      continue;
    }

    if (parts.length > 1) {
      formattedParts.push(`\`\`\`\n${trimmed}\n\`\`\``);
    } else {
      formattedParts.push(trimmed);
    }
  }

  return formattedParts;
}
