import type { Context, NextFunction } from "grammy";
import { telegramOutageNoticeService } from "../../app/services/telegram-outage-notice-service.js";
import { flushTelegramOutageNotices } from "../telegram-outage-notices.js";
import { logger } from "../../utils/logger.js";

// Telegram keeps undelivered updates for up to 24 hours, so a message can reach
// the bot long after it was sent - after a restart, or after long polling was
// interrupted by a network outage. Acting on such a message is unwanted: it
// would start tasks the user no longer expects to run.
const MAX_MESSAGE_AGE_SECONDS = 60;
// Callback presses carry no user-action timestamp (`ctx.msg` resolves to the
// bot's own message holding the buttons), so they cannot share the 60s gate.
// Gate them instead at Telegram's own 24h update-retention ceiling using the
// bot message date: fresh menus are unaffected, day-old presses are dropped.
const MAX_CALLBACK_MESSAGE_AGE_SECONDS = 24 * 60 * 60;

export async function staleUpdateMiddleware(ctx: Context, next: NextFunction): Promise<void> {
  // Only `ctx.message` carries the time the user acted. `ctx.msg` also resolves
  // to `ctx.callbackQuery.message`, which is the bot's own message holding the
  // buttons - using it here would drop every press under an older message.
  const message = ctx.message;
  if (!message) {
    if (await isStaleCallback(ctx)) {
      return;
    }
    await next();
    return;
  }

  const ageSeconds = Math.floor(Date.now() / 1000) - message.date;
  const chatId = ctx.chat?.id;
  const canNotify = typeof chatId === "number" && ctx.api !== undefined;

  if (ageSeconds <= MAX_MESSAGE_AGE_SECONDS) {
    telegramOutageNoticeService.closeBurst();
    if (canNotify) {
      await flushTelegramOutageNotices({ api: ctx.api, chatId });
    }
    await next();
    return;
  }

  telegramOutageNoticeService.markMessagesSkipped();
  logger.warn(
    `[StaleUpdate] Ignored stale message: ageSeconds=${ageSeconds}, updateId=${ctx.update.update_id}, messageId=${message.message_id}`,
  );
  if (canNotify) {
    await flushTelegramOutageNotices({ api: ctx.api, chatId });
  }
}

/**
 * Drops button presses under bot messages older than Telegram's update
 * retention. A `date` of 0 marks an inaccessible message (deleted/migrated
 * chat): there is nothing to age-gate there, so those pass through to the
 * regular per-flow guards.
 */
async function isStaleCallback(ctx: Context): Promise<boolean> {
  const callbackMessage = ctx.callbackQuery?.message;
  const messageDate =
    callbackMessage && "date" in callbackMessage && typeof callbackMessage.date === "number"
      ? callbackMessage.date
      : null;

  if (messageDate === null || messageDate <= 0) {
    return false;
  }

  const ageSeconds = Math.floor(Date.now() / 1000) - messageDate;
  if (ageSeconds <= MAX_CALLBACK_MESSAGE_AGE_SECONDS) {
    return false;
  }

  telegramOutageNoticeService.markMessagesSkipped();
  logger.warn(
    `[StaleUpdate] Ignored stale callback: ageSeconds=${ageSeconds}, updateId=${ctx.update.update_id}`,
  );
  const chatId = ctx.chat?.id;
  if (typeof chatId === "number" && ctx.api !== undefined) {
    await flushTelegramOutageNotices({ api: ctx.api, chatId });
  }
  return true;
}
