import type { CommandContext, Context } from "grammy";
import { isAllowedTelegramUser } from "../../config.js";
import { t } from "../../i18n/index.js";
import { logger } from "../../utils/logger.js";

/**
 * Owner-only process restart. Replies first, then exits non-zero so the
 * supervisor (systemd/Docker/Railway restart policy) boots a fresh instance.
 * This restarts the process, not a fresh image build — redeploys still
 * happen from git.
 */
export async function restartCommand(ctx: CommandContext<Context>): Promise<void> {
  if (!isAllowedTelegramUser(ctx.from?.id)) {
    await ctx.reply(t("tier.blocked"));
    return;
  }
  logger.warn(`[Bot] Restart requested by owner: userId=${ctx.from?.id}`);
  await ctx.reply(t("restart.scheduled"));
  // Not unref'd: the timer itself must keep the process alive until it fires.
  setTimeout(() => {
    process.exit(1);
  }, 1500);
}
