import type { Context } from "grammy";
import type { IncomingPrompt } from "../../app/types/prompt.js";
import { processUserPrompt, type ProcessPromptDeps } from "./prompt.js";
import { logger } from "../../utils/logger.js";

const TELEGRAM_SPLIT_CHUNK_MIN_LENGTH = 4000;
// Telegram delivers a single message update with at most this many characters;
// longer texts arrive as consecutive updates split on exact boundaries.
const TELEGRAM_MAX_MESSAGE_LENGTH = 4096;

interface PendingPrompt {
  inputs: IncomingPrompt[];
  ctx: Context;
  deps: ProcessPromptDeps;
  timer: ReturnType<typeof setTimeout>;
}

// Buffered plain-text prompts, keyed by chat id. Telegram delivers one long
// message (or one paste) as several consecutive updates; merging them here
// turns those chunks into a single OpenCode prompt.
const pendingByChat = new Map<number, PendingPrompt>();

function flushPending(chatId: number): void {
  const pending = pendingByChat.get(chatId);
  if (!pending) {
    return;
  }

  pendingByChat.delete(chatId);
  clearTimeout(pending.timer);

  const { inputs, ctx, deps } = pending;
  if (inputs.length > 1) {
    logger.info(
      `[Bot] Merging ${inputs.length} quick consecutive messages into one prompt (chatId=${chatId}, totalLength=${inputs.reduce((sum, input) => sum + input.text.length, 0)})`,
    );
  } else {
    logger.debug(`[Bot] Flushing single pending prompt (chatId=${chatId})`);
  }

  void processUserPrompt(ctx, mergeIncomingPrompts(inputs), deps).catch((err) => {
    logger.error(`[Bot] Failed to process merged prompt (chatId=${chatId})`, err);
  });
}

/**
 * Buffers a near-limit plain-text prompt so Telegram-split chunks are merged
 * into a single OpenCode prompt. Short messages are processed immediately
 * unless they follow a buffered chunk. Each new chunk restarts the wait window.
 *
 * Pass `mergeWindowMs <= 0` to disable merging and process the message
 * immediately.
 */
export function queuePromptForMerging(
  ctx: Context,
  input: IncomingPrompt,
  deps: ProcessPromptDeps,
  mergeWindowMs: number,
): void {
  const chatId = ctx.chat!.id;
  const existing = pendingByChat.get(chatId);

  if (mergeWindowMs <= 0 || (!existing && input.text.length < TELEGRAM_SPLIT_CHUNK_MIN_LENGTH)) {
    void processUserPrompt(ctx, input, deps).catch((err) => {
      logger.error(`[Bot] Failed to process prompt (chatId=${chatId})`, err);
    });
    return;
  }

  if (existing) {
    existing.inputs.push(input);
    existing.ctx = ctx;
    clearTimeout(existing.timer);
    existing.timer = setTimeout(() => flushPending(chatId), mergeWindowMs);
    logger.debug(
      `[Bot] Appended message to pending prompt (chatId=${chatId}, parts=${existing.inputs.length})`,
    );
    return;
  }

  const timer = setTimeout(() => flushPending(chatId), mergeWindowMs);
  pendingByChat.set(chatId, { inputs: [input], ctx, deps, timer });
  logger.debug(
    `[Bot] Started prompt merge window (chatId=${chatId}, mergeWindowMs=${mergeWindowMs})`,
  );
}

/** Immediately flush any buffered prompt for the chat (e.g. when a command arrives). */
export function flushPendingPrompt(chatId: number): void {
  flushPending(chatId);
}

/** Test helper: clears all buffered prompts and their timers. */
export function __resetMessageMergerForTests(): void {
  for (const pending of pendingByChat.values()) {
    clearTimeout(pending.timer);
  }
  pendingByChat.clear();
}

function mergeIncomingPrompts(inputs: IncomingPrompt[]): IncomingPrompt {
  // A preceding chunk that fills a whole Telegram update is an incomplete
  // split piece: rejoin it exactly so words and code are not corrupted with an
  // injected blank line. Shorter chunks are separate messages: keep the blank
  // line between them.
  let text = "";
  for (const [index, input] of inputs.entries()) {
    if (index > 0) {
      text += inputs[index - 1]!.text.length >= TELEGRAM_MAX_MESSAGE_LENGTH ? "" : "\n\n";
    }
    text += input.text;
  }

  return {
    text,
    fileParts: inputs.flatMap((input) => input.fileParts),
    photos: inputs.flatMap((input) => input.photos),
  };
}
