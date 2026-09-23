import type { Context } from "grammy";
import { logger } from "../../utils/logger.js";
import { alert, failure } from "./feedback.js";
import {
  claimPendingGuestQuestion,
  parseGuestQuestionCallback,
  requeuePendingGuestQuestion,
  submitGuestQuestionAnswer,
} from "../inline/guest-questions.js";

/**
 * Answers a pending guest model question from an in-message button tap.
 * Shares the pending entry with numbered replies through atomic claiming:
 * whichever arrives first wins, the other finds nothing and stands down.
 */
export async function handleGuestQuestionCallback(ctx: Context): Promise<boolean> {
  const data = ctx.callbackQuery?.data;
  const parsed = data ? parseGuestQuestionCallback(data) : null;
  if (!parsed) {
    return false;
  }

  const pending = claimPendingGuestQuestion(parsed.chatId);
  if (!pending) {
    await alert(ctx, "inline.inactive_callback");
    return true;
  }

  if (parsed.optionIndex < 0 || parsed.optionIndex >= pending.options.length) {
    logger.warn(
      `[Bot] Guest question tap out of range: chat=${parsed.chatId}, option=${parsed.optionIndex}`,
    );
    await alert(ctx, "inline.inactive_callback");
    return true;
  }

  const submitted = await submitGuestQuestionAnswer(pending, parsed.optionIndex);
  if (!submitted) {
    requeuePendingGuestQuestion(parsed.chatId, pending);
    await failure(ctx, "callback.processing_error");
    return true;
  }

  const label = pending.options[parsed.optionIndex]?.label ?? String(parsed.optionIndex + 1);
  await ctx.answerCallbackQuery({ text: `✓ ${label}`.slice(0, 200) }).catch(() => {});
  return true;
}
