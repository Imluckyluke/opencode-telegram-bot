import type { CommandContext, Context } from "grammy";
import { t } from "../../i18n/index.js";
import { logger } from "../../utils/logger.js";
import { getCurrentProject } from "../../app/stores/settings-store.js";
import { foregroundSessionState } from "../../app/managers/foreground-session-state-manager.js";
import {
  collectModelProbeTargets,
  probeModel,
  type ModelProbeResult,
} from "../../app/services/model-test-service.js";

function formatSeconds(latencyMs: number | undefined): string {
  if (latencyMs === undefined) {
    return "?";
  }
  return `${(latencyMs / 1000).toFixed(0)}s`;
}

function formatResultLine(result: ModelProbeResult): string {
  const name = `${result.providerID}/${result.modelID}`;
  if (result.ok) {
    return `✅ ${name} (${formatSeconds(result.latencyMs)})`;
  }
  return `❌ ${name} — ${result.error ?? "failed"}`;
}

export async function testModelsCommand(ctx: CommandContext<Context>): Promise<void> {
  const project = getCurrentProject();
  if (!project) {
    await ctx.reply(t("bot.project_not_selected"));
    return;
  }

  if (foregroundSessionState.isBusy()) {
    await ctx.reply(t("bot.session_busy"));
    return;
  }

  const targets = await collectModelProbeTargets();
  if (targets.length === 0) {
    await ctx.reply(t("testmodels.empty"));
    return;
  }

  logger.info(`[Bot] Testing ${targets.length} models in ${project.worktree}`);
  const progressMessage = await ctx.reply(t("testmodels.start", { count: targets.length }));
  const results: ModelProbeResult[] = [];

  for (const target of targets) {
    let result: ModelProbeResult;
    try {
      result = await probeModel(project.worktree, target);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("[Bot] Model probe crashed:", error);
      result = { ...target, ok: false, error: message.slice(0, 200) };
    }
    results.push(result);
    logger.info(
      `[Bot] Model probe ${results.length}/${targets.length}: ${target.providerID}/${target.modelID} ok=${result.ok}`,
    );

    const lines = [t("testmodels.header"), ...results.map(formatResultLine)];
    if (results.length < targets.length) {
      lines.push(`… (${results.length}/${targets.length})`);
    }
    await ctx.api
      .editMessageText(ctx.chat!.id, progressMessage.message_id, lines.join("\n"))
      .catch(() => {});
  }

  const passed = results.filter((result) => result.ok).length;
  const lines = [
    `${t("testmodels.header")} ${passed}/${results.length}`,
    ...results.map(formatResultLine),
  ];
  await ctx.api
    .editMessageText(ctx.chat!.id, progressMessage.message_id, lines.join("\n"))
    .catch(() => {});
}
