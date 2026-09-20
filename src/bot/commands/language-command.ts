import type { CommandContext, Context } from "grammy";
import { buildLanguageMenuView } from "../menus/language-menu.js";
import { replyWithInlineMenu } from "../menus/inline-menu.js";

export async function languageCommand(ctx: CommandContext<Context>): Promise<void> {
  const { text, keyboard } = buildLanguageMenuView();

  await replyWithInlineMenu(ctx, {
    menuKind: "language",
    text,
    keyboard,
  });
}
