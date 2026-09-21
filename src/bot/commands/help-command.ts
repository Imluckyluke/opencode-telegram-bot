import type { CommandContext, Context } from "grammy";
import { t } from "../../i18n/index.js";
import type { I18nKey } from "../../i18n/en.js";
import { getLocalizedBotCommands } from "./definitions.js";
import { sendMessageWithMarkdownFallback } from "../messages/send-with-markdown-fallback.js";

interface HelpGroup {
  titleKey: I18nKey;
  commands: string[];
}

const HELP_GROUPS: HelpGroup[] = [
  {
    titleKey: "help.group.sessions",
    commands: ["new", "sessions", "messages", "projects", "worktree", "open", "rename", "detach", "abort"],
  },
  {
    titleKey: "help.group.models",
    commands: ["model", "agent", "variant", "inlinemodel"],
  },
  {
    titleKey: "help.group.automation",
    commands: ["task", "tasklist", "commands", "skills", "mcps"],
  },
  {
    titleKey: "help.group.system",
    commands: ["status", "settings", "language", "ls", "opencode_start", "opencode_stop", "help"],
  },
];

export function formatHelpText(): string {
  const descriptions = new Map(
    getLocalizedBotCommands().map((item) => [item.command, item.description] as const),
  );

  const lines: string[] = [`📖 *${t("cmd.description.help")}*`, "", t("help.intro"), ""];

  for (const group of HELP_GROUPS) {
    lines.push(`*${t(group.titleKey)}*`);
    for (const command of group.commands) {
      const description = descriptions.get(command);
      if (description) {
        lines.push(`/${command} — ${description}`);
      }
    }
    lines.push("");
  }

  lines.push(t("help.footer"));
  lines.push("");
  lines.push(t("help.keyboard_hint"));

  return lines.join("\n");
}

export async function helpCommand(ctx: CommandContext<Context>): Promise<void> {
  const text = formatHelpText();
  if (!ctx.chat) {
    await ctx.reply(text);
    return;
  }
  await sendMessageWithMarkdownFallback({
    api: ctx.api,
    chatId: ctx.chat.id,
    text,
    parseMode: "Markdown",
  });
}
