import type { CommandContext, Context } from "grammy";
import { isAllowedTelegramUser } from "../../config.js";
import {
  addExtraAllowedUserId,
  getExtraAllowedUserIds,
  removeExtraAllowedUserId,
} from "../../app/stores/settings-store.js";
import { t } from "../../i18n/index.js";
import { logger } from "../../utils/logger.js";

function parseUserId(raw: string): number | null {
  const parsed = Number.parseInt(raw.trim(), 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    return null;
  }
  return parsed;
}

function formatUserId(userId: number): string {
  return `\`${userId}\``;
}

function describeUser(from: { id?: number; username?: string; first_name?: string } | undefined): string | null {
  const id = typeof from?.id === "number" ? from.id : null;
  if (!id || !Number.isSafeInteger(id) || id <= 0) {
    return null;
  }
  const name = from?.username ? `@${from.username}` : from?.first_name;
  return name ? `${formatUserId(id)} (${name})` : formatUserId(id);
}

export async function allowCommand(ctx: CommandContext<Context>): Promise<void> {
  // Only env-listed owners may grant access (tier middleware already blocks
  // everyone else, this is defense in depth).
  if (!isAllowedTelegramUser(ctx.from?.id)) {
    await ctx.reply(t("tier.blocked"));
    return;
  }

  const rawText = ctx.message?.text ?? "";
  const argParts = rawText
    .replace(/^\/allow(@\w+)?/, "")
    .trim()
    .split(/\s+/)
    .filter((part) => part.length > 0);
  const [sub = "", ...restParts] = argParts;
  const rest = restParts.join(" ");

  if (!sub) {
    const repliedId =
      ctx.message && "reply_to_message" in ctx.message
        ? ((ctx.message.reply_to_message as { from?: { id?: number; username?: string; first_name?: string } } | undefined)?.from ?? undefined)
        : undefined;
    const replied = describeUser(repliedId);
    if (replied && typeof repliedId?.id === "number") {
      await grantUser(ctx, repliedId.id, replied);
      return;
    }
    const extra = getExtraAllowedUserIds();
    await ctx.reply(
      extra.length > 0 ? t("allow.list", { users: extra.map(formatUserId).join(", ") }) : t("allow.list_empty"),
      { parse_mode: "Markdown" },
    );
    await ctx.reply(t("allow.usage"));
    return;
  }

  const lowered = sub.toLowerCase();
  if (lowered === "remove" || lowered === "revoke" || lowered === "delete" || lowered === "rm") {
    const target = parseUserId(rest);
    if (!target) {
      await ctx.reply(t("allow.invalid"));
      return;
    }
    if (removeExtraAllowedUserId(target)) {
      logger.info(`[Bot] Access revoked: userId=${target}`);
      await ctx.reply(t("allow.revoked", { user: formatUserId(target) }), {
        parse_mode: "Markdown",
      });
    } else {
      await ctx.reply(t("allow.not_found", { user: formatUserId(target) }), {
        parse_mode: "Markdown",
      });
    }
    return;
  }

  if (lowered === "list") {
    const extra = getExtraAllowedUserIds();
    await ctx.reply(
      extra.length > 0 ? t("allow.list", { users: extra.map(formatUserId).join(", ") }) : t("allow.list_empty"),
      { parse_mode: "Markdown" },
    );
    return;
  }

  const target = parseUserId(sub);
  if (!target) {
    await ctx.reply(t("allow.invalid"));
    return;
  }
  await grantUser(ctx, target, formatUserId(target));
}

async function grantUser(ctx: CommandContext<Context>, userId: number, label: string): Promise<void> {
  if (isAllowedTelegramUser(userId)) {
    await ctx.reply(t("allow.exists", { user: label }), { parse_mode: "Markdown" });
    return;
  }
  if (addExtraAllowedUserId(userId)) {
    logger.info(`[Bot] Access granted: userId=${userId}`);
    await ctx.reply(t("allow.granted", { user: label }), { parse_mode: "Markdown" });
  } else {
    await ctx.reply(t("allow.exists", { user: label }), { parse_mode: "Markdown" });
  }
}
