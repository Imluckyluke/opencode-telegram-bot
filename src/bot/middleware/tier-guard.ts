import type { Context, NextFunction } from "grammy";
import { isAllowedTelegramUser } from "../../config.js";
import { t } from "../../i18n/index.js";
import { logger } from "../../utils/logger.js";

/**
 * Owner-only commands: change shared settings, models, schedules, or the
 * server itself. Extra (granted) users can use the bot but not reconfigure it.
 */
const OWNER_COMMANDS = new Set([
  "settings",
  "model",
  "agent",
  "variant",
  "inlinemodel",
  "language",
  "task",
  "tasklist",
  "rename",
  "mcps",
  "opencode_start",
  "opencode_stop",
  "testmodels",
  "allow",
]);

/** Callback prefixes that mutate shared configuration. */
const OWNER_CALLBACK_PREFIXES = [
  "settings:",
  "model:",
  "agent",
  "variant",
  "task",
  "tasklist",
  "mcps",
];

function normalizeCommand(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) {
    return null;
  }
  const token = trimmed.split(/\s+/)[0] ?? "";
  const command = token.split("@")[0]?.toLowerCase().slice(1);
  return command || null;
}

function callbackPrefix(data: string): string | null {
  const separator = data.indexOf(":");
  if (separator <= 0) {
    return data;
  }
  return data.slice(0, separator + 1);
}

/**
 * Blocks configuration-changing commands and callbacks for granted
 * (non-owner) users. Owners (env whitelist) always pass through.
 */
export async function tierGuardMiddleware(ctx: Context, next: NextFunction): Promise<void> {
  const userId = ctx.from?.id;
  if (typeof userId !== "number" || isAllowedTelegramUser(userId)) {
    await next();
    return;
  }

  const command = ctx.message?.text ? normalizeCommand(ctx.message.text) : null;
  const data = ctx.callbackQuery?.data;
  const prefix = data ? callbackPrefix(data) : null;
  const blocked =
    (command !== null && OWNER_COMMANDS.has(command)) ||
    (prefix !== null &&
      OWNER_CALLBACK_PREFIXES.some(
        (restricted) => prefix === restricted || prefix.startsWith(restricted),
      ));

  if (!blocked) {
    await next();
    return;
  }

  logger.debug(`[TierGuard] Blocked owner-only action for userId=${userId}`);
  if (ctx.callbackQuery) {
    await ctx.answerCallbackQuery({ text: t("tier.blocked"), show_alert: true }).catch(() => {});
    return;
  }
  if (ctx.chat) {
    await ctx.reply(t("tier.blocked")).catch(() => {});
  }
}
