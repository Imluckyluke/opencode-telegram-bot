import { opencodeClient } from "../../opencode/client.js";
import { logger } from "../../utils/logger.js";
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

const pendingByChatId = new Map<number, GuestPendingQuestion>();

export function setPendingGuestQuestion(chatId: number, pending: GuestPendingQuestion): void {
  pendingByChatId.set(chatId, pending);
}

/** Returns the live pending question for a chat, sweeping expired ones. */
export function peekPendingGuestQuestion(chatId: number, now: number = Date.now()): GuestPendingQuestion | null {
  const pending = pendingByChatId.get(chatId);
  if (!pending) {
    return null;
  }
  if (now >= pending.expiresAt) {
    pendingByChatId.delete(chatId);
    return null;
  }
  return pending;
}

export function clearPendingGuestQuestion(chatId: number): void {
  pendingByChatId.delete(chatId);
}

/** Test helper: resets module state. */
export function __resetPendingGuestQuestionsForTests(): void {
  pendingByChatId.clear();
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
