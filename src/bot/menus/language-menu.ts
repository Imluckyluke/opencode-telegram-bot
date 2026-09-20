import { InlineKeyboard } from "grammy";
import { getLocale, getLocaleOptions, t } from "../../i18n/index.js";

export const LANGUAGE_SET_CALLBACK_PREFIX = "language:set:";

export function buildLanguageMenuView(): { text: string; keyboard: InlineKeyboard } {
  const current = getLocale();
  const keyboard = new InlineKeyboard();

  let first = true;
  for (const { code, label } of getLocaleOptions()) {
    if (!first) {
      keyboard.row();
    }
    first = false;
    keyboard.text(`${code === current ? "✅ " : ""}${label}`, `${LANGUAGE_SET_CALLBACK_PREFIX}${code}`);
  }

  return { text: t("language.menu.title"), keyboard };
}

export function getLocaleLabel(code: string): string {
  return getLocaleOptions().find((option) => option.code === code)?.label ?? code;
}
