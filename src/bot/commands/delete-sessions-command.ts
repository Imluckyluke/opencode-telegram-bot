import type { CommandContext, Context } from "grammy";
import { isAllowedTelegramUser } from "../../config.js";
import { opencodeClient } from "../../opencode/client.js";
import { getProjects } from "../../app/services/project-service.js";
import {
  clearAllUserSessions,
  clearSession,
  clearSessionDirectoryCache,
} from "../../app/stores/settings-store.js";
import { cleanupScheduledTaskSessionIgnores } from "../../app/services/scheduled-task-session-ignore-service.js";
import { pinnedMessageManager } from "../pinned/pinned-message-manager.js";
import { t } from "../../i18n/index.js";
import { logger } from "../../utils/logger.js";

async function deleteProjectSessions(worktree: string): Promise<{ deleted: number; failed: number }> {
  let deleted = 0;
  let failed = 0;
  try {
    const { data, error } = await opencodeClient.session.list({ directory: worktree });
    if (error || !data) {
      return { deleted, failed };
    }
    for (const session of data as Array<{ id?: string }>) {
      if (!session?.id) {
        continue;
      }
      try {
        await opencodeClient.session.delete({ sessionID: session.id, directory: worktree });
        deleted += 1;
      } catch (error) {
        failed += 1;
        logger.warn(`[Bot] Failed to delete session ${session.id}:`, error);
      }
    }
  } catch (error) {
    logger.warn(`[Bot] Failed to list sessions in ${worktree}:`, error);
  }
  return { deleted, failed };
}

/**
 * Owner-only instant wipe: deletes every OpenCode session in every known
 * project and drops all bot-side session state (current, per-user, cache,
 * dashboard). Scheduled task definitions are kept; their temp sessions are
 * recreated on the next run.
 */
export async function deleteSessionsCommand(ctx: CommandContext<Context>): Promise<void> {
  if (!isAllowedTelegramUser(ctx.from?.id)) {
    await ctx.reply(t("tier.blocked"));
    return;
  }

  const statusMessage = await ctx.reply(t("deletesessions.started")).catch(() => undefined);
  let deleted = 0;
  let failed = 0;
  try {
    const projects = await getProjects().catch(() => []);
    for (const project of projects) {
      const result = await deleteProjectSessions(project.worktree);
      deleted += result.deleted;
      failed += result.failed;
    }
  } catch (error) {
    logger.error("[Bot] Session wipe failed:", error);
  }

  clearSession();
  clearSessionDirectoryCache();
  const droppedUserSessions = clearAllUserSessions();
  await cleanupScheduledTaskSessionIgnores().catch(() => {});
  await pinnedMessageManager.clear().catch(() => {});

  logger.warn(
    `[Bot] Sessions wiped by owner: deleted=${deleted}, failed=${failed}, userSessions=${droppedUserSessions}`,
  );
  const doneText = t("deletesessions.done", { deleted, failed });
  if (statusMessage && typeof statusMessage.message_id === "number") {
    await ctx.api
      .editMessageText(ctx.chat!.id, statusMessage.message_id, doneText)
      .catch(() => {});
  } else {
    // The "started" notice never went out (send failed): deliver the result
    // as a fresh message instead of crashing after the wipe already ran.
    await ctx.reply(doneText).catch(() => {});
  }
}
