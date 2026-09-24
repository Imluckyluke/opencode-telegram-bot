import type { Context, Keyboard } from "grammy";
import type { I18nKey } from "../../i18n/en.js";
import { t } from "../../i18n/index.js";
import { logger } from "../../utils/logger.js";

/**
 * Feedback rules for callback handlers:
 *
 * 1. An action that changes the reply keyboard answers the callback without text
 *    and sends a message carrying the new keyboard (`switched`) - Telegram cannot
 *    update a reply keyboard any other way.
 * 2. An action inside a menu that leaves the keyboard alone shows a toast and
 *    edits the menu in place.
 * 3. An error or a refusal answers the callback only (`notify`/`alert`/`failure`)
 *    and never writes to the chat.
 * 4. The callback is always answered before the message is edited.
 * 5. A handler that answered the callback returns `true`.
 */

// Telegram rejects callback answers longer than this.
const CALLBACK_ANSWER_MAX_LENGTH = 200;

type FeedbackParams = Record<string, string | number | boolean | null | undefined>;

function resolveAnswerText(key: I18nKey, params?: FeedbackParams): string {
  const text = t(key, params);

  if (text.length <= CALLBACK_ANSWER_MAX_LENGTH) {
    return text;
  }

  logger.warn(
    `[Feedback] Callback answer truncated: key=${key}, length=${text.length}, limit=${CALLBACK_ANSWER_MAX_LENGTH}`,
  );

  return text.slice(0, CALLBACK_ANSWER_MAX_LENGTH);
}

/** Toast at the top of the screen: success, short operational errors, empty page. */
export async function notify(ctx: Context, key: I18nKey, params?: FeedbackParams): Promise<void> {
  await ctx.answerCallbackQuery({ text: resolveAnswerText(key, params) });
}

/** Modal the user has to dismiss: inactive menu, access denied, "do X first". */
export async function alert(ctx: Context, key: I18nKey, params?: FeedbackParams): Promise<void> {
  await ctx.answerCallbackQuery({ text: resolveAnswerText(key, params), show_alert: true });
}

/** Toast for `catch` blocks: reports the failure without throwing a second one. */
export async function failure(ctx: Context, key: I18nKey, params?: FeedbackParams): Promise<void> {
  await ctx.answerCallbackQuery({ text: resolveAnswerText(key, params) }).catch(() => {});
}

/**
 * Rule 1: confirm a switch that changes the reply keyboard. The toast is
 * deliberately empty - the message below is the confirmation.
 */
export async function switched(
  ctx: Context,
  text: string,
  keyboard: Keyboard | { remove_keyboard: true },
): Promise<void> {
  await ctx.answerCallbackQuery();
  await ctx.reply(text, { reply_markup: keyboard });
  await ctx.deleteMessage().catch(() => {});
}

/** Cancel a menu: the message is removed, so the toast is the only feedback. */
export async function cancelMenu(ctx: Context): Promise<void> {
  await ctx.answerCallbackQuery({ text: resolveAnswerText("common.cancelled") }).catch(() => {});
  await ctx.deleteMessage().catch(() => {});
}

/**
 * Cancel a prompt that asked for input: the message stays as a trace and its
 * text is replaced with the context-specific one.
 */
export async function cancelPrompt(ctx: Context, key: I18nKey): Promise<void> {
  await ctx.answerCallbackQuery({ text: resolveAnswerText("common.cancelled") }).catch(() => {});
  // Drop the keyboard along with the text so the button cannot be pressed twice.
  await ctx.editMessageText(t(key)).catch(() => {});
}
