import { opencodeV2Client } from "../../opencode/client.js";
import { refreshModelCatalogAfterConfigReload } from "../../opencode/ready-refresh.js";
import type { ModelInfo } from "../types/model.js";
import { logger } from "../../utils/logger.js";
import { extractErrorMessage } from "../../utils/opencode-error.js";
import { getStoredModel } from "./model-selection-service.js";

// A reload rebuilds every loaded location, MCP servers and plugins included.
const CONFIG_RELOAD_TIMEOUT_MS = 60_000;

export type ConfigReloadResult =
  | { kind: "success"; modelChanged: boolean }
  | { kind: "failed"; error: string | null }
  | { kind: "timeout" };

let reloadInFlight: Promise<ConfigReloadResult> | null = null;

function isSameModel(left: ModelInfo, right: ModelInfo): boolean {
  return (
    left.providerID === right.providerID &&
    left.modelID === right.modelID &&
    left.variant === right.variant
  );
}

async function reloadAndRefreshModelCatalog(): Promise<ConfigReloadResult> {
  const { error } = await opencodeV2Client.location.reload();
  if (error) {
    logger.warn("[ConfigReload] OpenCode rejected the config reload", error);
    return { kind: "failed", error: extractErrorMessage(error) };
  }

  logger.info("[ConfigReload] OpenCode configuration reloaded");
  const modelBefore = { ...getStoredModel() };
  try {
    await refreshModelCatalogAfterConfigReload();
  } catch (refreshError) {
    logger.warn("[ConfigReload] Failed to refresh the model catalog after reload", refreshError);
  }

  return { kind: "success", modelChanged: !isSameModel(modelBefore, getStoredModel()) };
}

function startReload(): Promise<ConfigReloadResult> {
  const operation = reloadAndRefreshModelCatalog().finally(() => {
    if (reloadInFlight === operation) {
      reloadInFlight = null;
    }
  });
  reloadInFlight = operation;
  return operation;
}

/**
 * Asks the V2 server to reload its configuration and re-reads the model catalog after it.
 * A call made while a reload is in flight joins it. The time limit ends only the wait: a
 * reload that succeeds later still refreshes the catalog, and the next call starts afresh.
 */
export async function reloadOpencodeConfig(): Promise<ConfigReloadResult> {
  const operation = reloadInFlight ?? startReload();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<ConfigReloadResult>((resolve) => {
    timer = setTimeout(() => resolve({ kind: "timeout" }), CONFIG_RELOAD_TIMEOUT_MS);
  });

  try {
    const result = await Promise.race([operation, timeout]);
    if (result.kind === "timeout") {
      logger.warn(`[ConfigReload] Config reload timed out after ${CONFIG_RELOAD_TIMEOUT_MS}ms`);
      if (reloadInFlight === operation) {
        reloadInFlight = null;
      }
    }
    return result;
  } finally {
    clearTimeout(timer);
  }
}

export function __resetConfigReloadForTests(): void {
  reloadInFlight = null;
}
