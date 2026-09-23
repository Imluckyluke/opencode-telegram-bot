import { opencodeClient } from "../../opencode/client.js";
import { logger } from "../../utils/logger.js";
import type { TelegramRichBlock } from "../render/types.js";
import type { InteractiveQuestion } from "./run-waiter.js";

/**
 * Numbered question answering for guest chats. The model’s question is posted
 * as a numbered table into the inline answer message; the caller replies with
 * just the option number. Replies are matched by chat (not by message id —
 * guest answers only expose an inline_message_id), so a bare number is
 * treated as an answer only while that chat has a pending question.
 */
export interface GuestPendingQuestion {
  sessionId: string;
  directory: string;
  requestId: string;
  question: string;
  options: Array<{ label: string; description?: string }>;
  inlineMessageId: string;
  expiresAt: number;
}

export const GUEST_QUESTION_REPLY_TIMEOUT_MS = 5 * 60 * 1000;

/** Callback data prefix for in-message buttons on guest question tables. */
export const GUEST_QUESTION_CALLBACK_PREFIX = "gq:";

const pendingByChatId = new Map<number, GuestPendingQuestion>();

export function setPendingGuestQuestion(chatId: number, pending: GuestPendingQuestion): void {
  pendingByChatId.set(chatId, pending);
}

/**
 * Atomically takes the live pending question for a chat (sweeping expired
 * ones). Taking removes it, so a button tap and a numbered reply racing each
 * other cannot answer twice — the loser finds nothing and stands down.
 */
export function claimPendingGuestQuestion(
  chatId: number,
  now: number = Date.now(),
): GuestPendingQuestion | null {
  const pending = pendingByChatId.get(chatId);
  if (!pending) {
    return null;
  }
  if (now >= pending.expiresAt) {
    pendingByChatId.delete(chatId);
    return null;
  }
  pendingByChatId.delete(chatId);
  return pending;
}

/** Puts a claimed entry back untouched (e.g. invalid input keeps its expiry). */
export function restorePendingGuestQuestion(chatId: number, pending: GuestPendingQuestion): void {
  pendingByChatId.set(chatId, pending);
}

/** Puts a claimed entry back with a fresh expiry (submit failed, retryable). */
export function requeuePendingGuestQuestion(chatId: number, pending: GuestPendingQuestion): void {
  pendingByChatId.set(chatId, { ...pending, expiresAt: Date.now() + GUEST_QUESTION_REPLY_TIMEOUT_MS });
}

export function clearPendingGuestQuestion(chatId: number): void {
  pendingByChatId.delete(chatId);
}

/** Test helper: resets module state. */
export function __resetPendingGuestQuestionsForTests(): void {
  pendingByChatId.clear();
}

/**
 * Parses button callback data ("gq:<chatId>:<optionIndex>"). Range is checked
 * against the pending entry by the caller.
 */
export function parseGuestQuestionCallback(data: string): {
  chatId: number;
  optionIndex: number;
} | null {
  if (!data.startsWith(GUEST_QUESTION_CALLBACK_PREFIX)) {
    return null;
  }
  const match = /^gq:(-?\d+):(\d+)$/.exec(data);
  if (!match) {
    return null;
  }
  const chatId = Number.parseInt(match[1] as string, 10);
  const optionIndex = Number.parseInt(match[2] as string, 10);
  if (!Number.isSafeInteger(chatId) || !Number.isInteger(optionIndex) || optionIndex < 0) {
    return null;
  }
  return { chatId, optionIndex };
}

/** "3" → 2 (zero-based) when it names one of `optionCount` options. */
export function parseGuestAnswerNumber(text: string, optionCount: number): number | null {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) {
    return null;
  }
  const index = Number.parseInt(trimmed, 10) - 1;
  if (!Number.isInteger(index) || index < 0 || index >= optionCount) {
    return null;
  }
  return index;
}

export function renderGuestQuestionTable(
  question: InteractiveQuestion,
  hint: string,
): string {
  const lines = [`❓ ${question.question.trim()}`];
  question.options.forEach((option, index) => {
    const suffix = option.description ? ` — ${option.description}` : "";
    lines.push(`${index + 1}. ${option.label}${suffix}`);
  });
  lines.push("", hint);
  return lines.join("\n");
}

/**
 * Rich version of the question table: the question, a real table with one
 * row per option, and one button row per option (a single row of buttons is
 * unreadable). Short labels ride on their button, long ones are replaced by
 * their number since the table already shows the full text.
 */
export function buildGuestQuestionBlocks(
  question: InteractiveQuestion,
  chatId: number,
): TelegramRichBlock[] {
  const headerRow = [
    { text: "#", is_header: true as const, align: "right" as const, valign: "top" as const },
    { text: "Option", is_header: true as const, align: "left" as const, valign: "top" as const },
  ];
  const bodyRows = question.options.map((option, index) => {
    const suffix = option.description ? ` — ${option.description}` : "";
    return [
      { text: String(index + 1), align: "right" as const, valign: "top" as const },
      { text: `${option.label}${suffix}`, align: "left" as const, valign: "top" as const },
    ];
  });

  const blocks: TelegramRichBlock[] = [
    { type: "paragraph", text: `❓ ${question.question.trim()}` },
    { type: "table", is_bordered: true, cells: [headerRow, ...bodyRows] },
  ];

  question.options.slice(0, 8).forEach((option, index) => {
    const full = `${index + 1}. ${option.label}`;
    const text = full.length > 32 ? String(index + 1) : full;
    blocks.push({
      type: "buttons",
      buttons: [{ text: text.slice(0, 64), callback_data: `gq:${chatId}:${index}` }],
    });
  });

  return blocks;
}

/** Formats the selected option the way DM answers do ("* Label: Description"). */
export function formatGuestAnswer(
  options: GuestPendingQuestion["options"],
  optionIndex: number,
): string | null {
  const option = options[optionIndex];
  if (!option) {
    return null;
  }
  return `* ${option.label}: ${option.description ?? ""}`;
}

/**
 * Submits the numbered answer to the agent. Returns true when the agent
 * accepted it; the caller clears the pending entry and lets the run continue.
 */
export async function submitGuestQuestionAnswer(
  pending: GuestPendingQuestion,
  optionIndex: number,
): Promise<boolean> {
  const answer = formatGuestAnswer(pending.options, optionIndex);
  if (!answer) {
    return false;
  }

  try {
    const { error } = await opencodeClient.question.reply({
      requestID: pending.requestId,
      directory: pending.directory,
      answers: [[answer]],
    });
    if (error) {
      logger.warn("[Bot] Guest question answer rejected by server:", error);
      return false;
    }
    logger.info(
      `[Bot] Guest question answered: session=${pending.sessionId}, option=${optionIndex + 1}`,
    );
    return true;
  } catch (error) {
    logger.warn("[Bot] Failed to submit guest question answer:", error);
    return false;
  }
}
