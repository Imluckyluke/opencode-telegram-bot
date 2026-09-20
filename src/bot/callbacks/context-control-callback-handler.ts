import { Context } from "grammy";
import { getCurrentSession } from "../../app/services/session-service.js";
import { compactCurrentSession } from "../../app/services/session-compact-service.js";
import { logger } from "../../utils/logger.js";
import { t } from "../../i18n/index.js";
import { alert, failure } from "./feedback.js";
import { clearActiveInlineMenu, ensureActiveInlineMenu } from "../menus/inline-menu.js";

/**
 * Handle compact confirmation callback
 * Calls OpenCode API to compact the session
 */
export async function handleCompactConfirm(ctx: Context): Promise<boolean> {
  const callbackQuery = ctx.callbackQuery;

  if (!callbackQuery?.data || callbackQuery.data !== "compact:confirm") {
    return false;
  }

  const isActiveMenu = await ensureActiveInlineMenu(ctx, "context");
  if (!isActiveMenu) {
    return true;
  }

  logger.debug("[ContextHandler] Compact confirmed");

  try {
    const session = getCurrentSession();

    if (!session) {
      clearActiveInlineMenu("context_session_missing");
      await alert(ctx, "context.no_active_session");
      await ctx.deleteMessage().catch(() => {});
      return true;
    }

    // Answer callback query and delete menu immediately
    await ctx.answerCallbackQuery({ text: t("context.callback_compacting") });
    clearActiveInlineMenu("context_compact_confirmed");
    await ctx.deleteMessage().catch(() => {});

    if (!ctx.chat) {
      await failure(ctx, "context.error");
      return true;
    }

    const outcome = await compactCurrentSession(ctx.api, ctx.chat.id);
    if (outcome !== "ok") {
      await failure(ctx, "context.error");
    }

    return true;
  } catch (err) {
    clearActiveInlineMenu("context_compact_error");
    logger.error("[ContextHandler] Compact exception:", err);
    await failure(ctx, "context.error");
    await ctx.deleteMessage().catch(() => {});
    return true;
  }
}
