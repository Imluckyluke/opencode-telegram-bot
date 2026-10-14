import path from "node:path";
import type { CommandContext, Context } from "grammy";
import { getProjectRoot, isWithinProjectRootSafe } from "../../app/services/file-browser-service.js";
import { interactionManager } from "../../app/managers/interaction-manager.js";
import { isForegroundBusy } from "../../app/services/run-control-service.js";
import { t } from "../../i18n/index.js";
import { isContainerRuntime } from "../../runtime/container.js";
import { clearLsPathIndex, renderLsBrowseView } from "../menus/file-browser-menu.js";
import { replyBusyBlocked } from "../messages/busy-blocked-renderer.js";
import { rememberLsDirectory, resolveInitialLsDirectory } from "../callbacks/file-browser-callback-handler.js";

export async function lsCommand(ctx: CommandContext<Context>): Promise<void> {
  if (isForegroundBusy()) {
    await replyBusyBlocked(ctx);
    return;
  }

  if (isContainerRuntime()) {
    await ctx.reply(t("runtime.container.command_unavailable"));
    return;
  }

  clearLsPathIndex();

  const projectRoot = getProjectRoot();
  if (!projectRoot) {
    await ctx.reply(t("bot.project_not_selected"));
    return;
  }

  const args = typeof ctx.match === "string" ? ctx.match.trim() : undefined;
  // Relative arguments are relative to the project root, not the bot's cwd.
  const targetDir = args
    ? path.resolve(projectRoot, args)
    : resolveInitialLsDirectory(ctx.from?.id);
  if (!targetDir) {
    await ctx.reply(t("bot.project_not_selected"));
    return;
  }

  // realpath-based check: a symlink inside the project must not escape it.
  if (!(await isWithinProjectRootSafe(targetDir))) {
    await ctx.reply(`❌ ${t("ls.access_denied")}`);
    return;
  }

  const view = await renderLsBrowseView(targetDir);
  if ("error" in view) {
    await ctx.reply(`❌ ${view.error}`);
    return;
  }

  rememberLsDirectory(ctx.from?.id, targetDir);

  if (!view.hasActions) {
    await ctx.reply(view.text, { parse_mode: "HTML" });
    return;
  }

  const message = await ctx.reply(view.text, { parse_mode: "HTML", reply_markup: view.keyboard });
  interactionManager.start({
    kind: "inline",
    expectedInput: "callback",
    metadata: {
      menuKind: "ls",
      messageId: message.message_id,
    },
  });
}
