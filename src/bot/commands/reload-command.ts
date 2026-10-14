import { CommandContext, Context } from "grammy";
import {
  reloadOpencodeConfig,
  type ConfigReloadResult,
} from "../../app/services/config-reload-service.js";
import { t } from "../../i18n/index.js";
import { logger } from "../../utils/logger.js";
import { safeBackgroundTask } from "../../utils/safe-background-task.js";
import { editBotText } from "../messages/telegram-text.js";
import { refreshModelViews } from "../services/model-views.js";

function formatReloadResult(result: ConfigReloadResult): string {
  if (result.kind === "success") {
    return t("reload.success");
  }
  if (result.kind === "failed" && result.error) {
    return t("reload.failed_with_error", { error: result.error });
  }
  return t("reload.failed");
}

async function reloadAndReport(
  ctx: CommandContext<Context>,
  statusMessageId: number,
): Promise<void> {
  let text: string;
  try {
    const result = await reloadOpencodeConfig();
    if (result.kind === "success" && result.modelChanged) {
      await refreshModelViews();
    }
    text = formatReloadResult(result);
  } catch (error) {
    logger.error("[Bot] Error in /reload command:", error);
    text = t("reload.failed");
  }

  await editBotText({
    api: ctx.api,
    chatId: ctx.chat.id,
    messageId: statusMessageId,
    text,
  });
}

/**
 * Command handler for /reload (OpenCode V2 only)
 * Reloads the server configuration; the rebuild runs in the background so the bot keeps
 * answering while it lasts.
 */
export async function reloadCommand(ctx: CommandContext<Context>): Promise<void> {
  try {
    const statusMessage = await ctx.reply(t("reload.reloading"));
    safeBackgroundTask({
      taskName: "bot.reloadOpencodeConfig",
      task: () => reloadAndReport(ctx, statusMessage.message_id),
    });
  } catch (error) {
    logger.error("[Bot] Error in /reload command:", error);
  }
}
