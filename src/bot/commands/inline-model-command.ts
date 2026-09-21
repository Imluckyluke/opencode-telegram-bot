import type { CommandContext, Context } from "grammy";
import { t } from "../../i18n/index.js";
import type { ModelInfo } from "../../app/types/model.js";
import { getProviderModels } from "../../app/services/model-selection-service.js";
import {
  clearInlineModel,
  getInlineModel,
  setInlineModel,
} from "../../app/stores/settings-store.js";
import { logger } from "../../utils/logger.js";

function formatInlineModel(model: ModelInfo): string {
  const base = `${model.providerID}/${model.modelID}`;
  return model.variant && model.variant !== "default" ? `${base} (${model.variant})` : base;
}

function parseModelRef(raw: string): { providerID: string; modelID: string } | null {
  const cleaned = raw.trim();
  const slash = cleaned.indexOf("/");
  if (slash <= 0 || slash === cleaned.length - 1) {
    return null;
  }
  return {
    providerID: cleaned.slice(0, slash).trim(),
    modelID: cleaned.slice(slash + 1).trim(),
  };
}

export async function inlineModelCommand(ctx: CommandContext<Context>): Promise<void> {
  const rawText = ctx.message?.text ?? "";
  const args = rawText
    .replace(/^\/inlinemodel(@\w+)?/, "")
    .trim();

  if (!args) {
    const current = getInlineModel();
    await ctx.reply(
      current?.providerID && current?.modelID
        ? t("inlinemodel.current", { model: formatInlineModel(current) })
        : t("inlinemodel.following"),
    );
    await ctx.reply(t("inlinemodel.usage"));
    return;
  }

  if (args.toLowerCase() === "default") {
    clearInlineModel();
    await ctx.reply(t("inlinemodel.cleared"));
    return;
  }

  const ref = parseModelRef(args);
  if (!ref) {
    await ctx.reply(t("inlinemodel.invalid"));
    return;
  }

  try {
    const catalog = await getProviderModels(ref.providerID);
    const match =
      catalog.find((model) => model.modelID === ref.modelID) ??
      catalog.find((model) => model.modelID.toLowerCase() === ref.modelID.toLowerCase());
    if (catalog.length > 0 && !match) {
      await ctx.reply(t("inlinemodel.invalid"));
      return;
    }
    const selected = {
      providerID: ref.providerID,
      modelID: match?.modelID ?? ref.modelID,
      variant: undefined as string | undefined,
    };
    setInlineModel(selected);
    logger.info(`[Bot] Inline model set: ${selected.providerID}/${selected.modelID}`);
    await ctx.reply(t("inlinemodel.saved", { model: formatInlineModel(selected) }));
  } catch (error) {
    logger.error("[Bot] Failed to validate inline model:", error);
    await ctx.reply(t("inlinemodel.invalid"));
  }
}
