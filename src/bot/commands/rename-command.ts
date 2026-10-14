import { CommandContext, Context } from "grammy";
import { fetchSessionTitle, getCurrentSession } from "../../app/services/session-service.js";
import { formatSessionTitle } from "../../app/formatters/session-title-formatter.js";
import { renameManager } from "../../app/managers/rename-manager.js";
import { interactionManager } from "../../app/managers/interaction-manager.js";
import { logger } from "../../utils/logger.js";
import { t } from "../../i18n/index.js";
import { buildRenameCancelKeyboard } from "../menus/rename-menu.js";

export async function renameCommand(ctx: CommandContext<Context>): Promise<void> {
  try {
    const currentSession = getCurrentSession();

    if (!currentSession) {
      await ctx.reply(t("rename.no_session"));
      return;
    }

    const currentTitle = await fetchSessionTitle(currentSession);
    const message = await ctx.reply(t("rename.prompt", { title: formatSessionTitle(currentTitle) }), {
      reply_markup: buildRenameCancelKeyboard(),
    });

    renameManager.startWaiting(currentSession.id, currentSession.directory, currentTitle);
    renameManager.setMessageId(message.message_id);
    interactionManager.start({
      kind: "rename",
      expectedInput: "text",
      metadata: {
        sessionId: currentSession.id,
        messageId: message.message_id,
      },
    });

    logger.info(`[RenameCommand] Waiting for new title for session: ${currentSession.id}`);
  } catch (error) {
    logger.error("[RenameCommand] Error starting rename flow:", error);
    await ctx.reply(t("rename.error"));
  }
}
