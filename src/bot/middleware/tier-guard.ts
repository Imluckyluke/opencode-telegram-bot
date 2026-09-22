import type { Context, NextFunction } from "grammy";
import { isAllowedTelegramUser } from "../../config.js";
import { isAllowedUser, isBotDisabled } from "../../app/stores/settings-store.js";
import { isUserLaneContent, processUserLaneMessage } from "../handlers/user-lane.js";
import { t } from "../../i18n/index.js";
import { logger } from "../../utils/logger.js";

/**
 * Access tiers + master kill-switch:
 * - Owners (env whitelist): everything, exactly as before.
 * - Granted users: exactly ONE personal chat session. Only plain content
 *   (text/voice/photo/files) flows into their lane; every command, button,
 *   inline query, and guest summons is denied. They never touch shared
 *   state (sessions, settings, keyboard, pinned dashboard).
 * - When disabled (/disable): only owner /enable passes; everyone else gets
 *   a notice (or silence where no chat exists).
 */
export async function tierGuardMiddleware(ctx: Context, next: NextFunction): Promise<void> {
  const userId = ctx.from?.id;
  if (typeof userId !== "number") {
    await next();
    return;
  }

  const owner = isAllowedTelegramUser(userId);
  const command = ctx.message?.text ? normalizeCommand(ctx.message.text) : null;
  if (isBotDisabled() && !(owner && command === "enable")) {
    logger.debug(`[TierGuard] Bot disabled, ignoring update from userId=${userId}`);
    if (ctx.callbackQuery) {
      await ctx.answerCallbackQuery({ text: t("bot.disabled") }).catch(() => {});
      return;
    }
    if (ctx.chat && ctx.message) {
      await ctx.reply(t("bot.disabled")).catch(() => {});
    }
    return;
  }

  if (owner) {
    await next();
    return;
  }

  if (!isAllowedUser(userId)) {
    // Not whitelisted at all (should already be stopped by auth): pass
    // through so auth semantics stay unchanged.
    await next();
    return;
  }

  if (isUserLaneContent(ctx)) {
    await processUserLaneMessage(ctx);
    return;
  }

  logger.debug(`[TierGuard] Denied non-content update for granted userId=${userId}`);
  if (ctx.callbackQuery) {
    await ctx.answerCallbackQuery({ text: t("tier.blocked"), show_alert: true }).catch(() => {});
    return;
  }
  if (ctx.inlineQuery) {
    await ctx.answerInlineQuery([], { cache_time: 0, is_personal: true }).catch(() => {});
    return;
  }
  if (ctx.chat && ctx.message) {
    await ctx.reply(t("tier.blocked")).catch(() => {});
  }
}

function normalizeCommand(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) {
    return null;
  }
  const token = trimmed.split(/\s+/)[0] ?? "";
  const command = token.split("@")[0]?.toLowerCase().slice(1);
  return command || null;
}
