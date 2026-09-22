import type { CommandContext, Context } from "grammy";
import { isAllowedTelegramUser } from "../../config.js";
import { isBotDisabled, setBotDisabled } from "../../app/stores/settings-store.js";
import { t } from "../../i18n/index.js";
import { logger } from "../../utils/logger.js";

export async function disableCommand(ctx: CommandContext<Context>): Promise<void> {
  if (!isAllowedTelegramUser(ctx.from?.id)) {
    await ctx.reply(t("tier.blocked"));
    return;
  }
  setBotDisabled(true);
  logger.warn(`[Bot] Bot disabled by owner: userId=${ctx.from?.id}`);
  await ctx.reply(t("bot.disabled_on"));
}

export async function enableCommand(ctx: CommandContext<Context>): Promise<void> {
  if (!isAllowedTelegramUser(ctx.from?.id)) {
    await ctx.reply(t("tier.blocked"));
    return;
  }
  const wasDisabled = isBotDisabled();
  setBotDisabled(false);
  logger.warn(`[Bot] Bot enabled by owner: userId=${ctx.from?.id}`);
  await ctx.reply(t(wasDisabled ? "bot.enabled" : "bot.already_enabled"));
}
