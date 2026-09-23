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
 *   and inline query is denied. Guest summons ARE allowed: each ask runs in
 *   a fresh session and the answer is posted in place, so shared state
 *   (sessions, settings, keyboard, pinned dashboard) is never touched.
 * - When disabled (/disable): only owner /enable passes; everyone else gets
 *   a notice (or silence where no chat exists).
 */
export async function tierGuardMiddleware(ctx: Context, next: NextFunction): Promise<void> {
  const userId = ctx.from?.id;
  // Guest-mode summons carry the authorizing party in the server-set
  // guest_bot_caller_user field (see authMiddleware). The guard must judge
  // the caller, not just ctx.from, otherwise owner kill-switch checks and
  // the granted-user guest denial below would look at the wrong identity.
  const guestMessage = (
    ctx.update as unknown as {
      guest_message?: { guest_bot_caller_user?: { id?: number } };
    } | undefined
  )?.guest_message;
  const guestCallerId = guestMessage?.guest_bot_caller_user?.id;
  if (typeof userId !== "number" && typeof guestCallerId !== "number") {
    await next();
    return;
  }

  const owner = isAllowedTelegramUser(userId) || isAllowedTelegramUser(guestCallerId);
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

  if (guestMessage) {
    // Owners already returned above. Granted users (/allow) may summon in
    // guest mode: each ask runs in a fresh session and the answer is posted
    // in place, so shared state is never touched. Strangers are dropped here
    // (auth upstream already stops them; this is defense in depth).
    const callerAllowed = isAllowedUser(guestCallerId) || isAllowedUser(userId);
    if (!callerAllowed) {
      logger.debug(
        `[TierGuard] Denied guest summons for non-whitelisted userId=${userId}, guestCallerId=${guestCallerId}`,
      );
      return;
    }
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
