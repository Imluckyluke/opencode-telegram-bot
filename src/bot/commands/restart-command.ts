import { type CommandContext, type Context, InlineKeyboard } from "grammy";
import { isAllowedTelegramUser } from "../../config.js";
import { cancelMenu } from "../callbacks/feedback.js";
import { t } from "../../i18n/index.js";
import { logger } from "../../utils/logger.js";

export const RESTART_CONFIRM_CALLBACK = "restart:confirm";
export const RESTART_CANCEL_CALLBACK = "restart:cancel";

/**
 * Owner-only process restart. Asks for a second confirmation first: the
 * restart drops all in-memory state and in-flight runs. Replies first, then
 * exits non-zero so the supervisor (systemd/Docker/Railway restart policy)
 * boots a fresh instance. This restarts the process, not a fresh image
 * build — redeploys still happen from git.
 */
export async function restartCommand(ctx: CommandContext<Context>): Promise<void> {
  if (!isAllowedTelegramUser(ctx.from?.id)) {
    await ctx.reply(t("tier.blocked"));
    return;
  }
  await ctx.reply(t("restart.confirm_text"), {
    reply_markup: new InlineKeyboard()
      .text(t("restart.confirm_yes"), RESTART_CONFIRM_CALLBACK)
      .text(t("inline.button.cancel"), RESTART_CANCEL_CALLBACK),
  });
}

export async function handleRestartCallback(ctx: Context): Promise<boolean> {
  const data = ctx.callbackQuery?.data;
  if (data !== RESTART_CONFIRM_CALLBACK && data !== RESTART_CANCEL_CALLBACK) {
    return false;
  }

  if (!isAllowedTelegramUser(ctx.from?.id)) {
    await ctx.answerCallbackQuery({ text: t("tier.blocked") });
    return true;
  }

  if (data === RESTART_CANCEL_CALLBACK) {
    await cancelMenu(ctx);
    return true;
  }

  await ctx.answerCallbackQuery();
  logger.warn(`[Bot] Restart requested by owner: userId=${ctx.from?.id}`);
  await ctx.reply(t("restart.scheduled"));
  // Not unref'd: the timer itself must keep the process alive until it fires.
  setTimeout(() => {
    process.exit(1);
  }, 1500);
  return true;
}
