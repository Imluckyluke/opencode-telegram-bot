import type { Context } from "grammy";
import {
  resolveSupportedLocale,
  setRuntimeLocale,
  t,
} from "../../i18n/index.js";
import { setPersistedLocale } from "../../app/stores/settings-store.js";
import { getLocalizedBotCommands } from "../commands/definitions.js";
import {
  appendInlineMenuCancelButton,
  ensureActiveInlineMenu,
} from "../menus/inline-menu.js";
import {
  buildLanguageMenuView,
  getLocaleLabel,
  LANGUAGE_SET_CALLBACK_PREFIX,
} from "../menus/language-menu.js";
import { logger } from "../../utils/logger.js";

export async function handleLanguageCallback(ctx: Context): Promise<boolean> {
  const data = ctx.callbackQuery?.data;
  if (!data?.startsWith(LANGUAGE_SET_CALLBACK_PREFIX)) {
    return false;
  }

  const isActiveMenu = await ensureActiveInlineMenu(ctx, "language");
  if (!isActiveMenu) {
    return true;
  }

  try {
    const locale = resolveSupportedLocale(data.slice(LANGUAGE_SET_CALLBACK_PREFIX.length));
    if (!locale) {
      await ctx.answerCallbackQuery({ text: t("callback.unknown_command") });
      return true;
    }

    setRuntimeLocale(locale);
    setPersistedLocale(locale);

    // Refresh the localized / command list for this chat.
    const chatId = ctx.chat?.id;
    if (ctx.api && chatId !== undefined) {
      await ctx.api
        .setMyCommands(getLocalizedBotCommands(), {
          scope: { type: "chat", chat_id: chatId },
        })
        .catch((error: unknown) => {
          logger.warn("[Language] Failed to refresh localized commands:", error);
        });
    }

    const view = buildLanguageMenuView();
    await ctx.answerCallbackQuery({
      text: t("language.selected", { language: getLocaleLabel(locale) }),
    });
    await ctx.editMessageText(view.text, {
      reply_markup: appendInlineMenuCancelButton(view.keyboard, "language"),
    });
    return true;
  } catch (error) {
    logger.error("[Language] Error handling language callback:", error);
    await ctx.answerCallbackQuery({ text: t("callback.processing_error") }).catch(() => {});
    return true;
  }
}
