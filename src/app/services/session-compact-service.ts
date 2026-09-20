import type { Api, RawApi } from "grammy";
import { opencodeClient } from "../../opencode/client.js";
import { getStoredModel } from "./model-selection-service.js";
import { getCurrentSession } from "./session-service.js";
import { t } from "../../i18n/index.js";
import { logger } from "../../utils/logger.js";

type CompactApi = Pick<Api<RawApi>, "sendMessage" | "editMessageText" | "sendChatAction">;

export type CompactOutcome = "ok" | "no-session" | "api-error" | "exception";

/**
 * Runs OpenCode AI compaction for the current session with progress notices.
 * Shared by the manual context menu and the automatic threshold trigger.
 */
export async function compactCurrentSession(
  api: CompactApi,
  chatId: number,
): Promise<CompactOutcome> {
  const session = getCurrentSession();
  if (!session) {
    return "no-session";
  }

  try {
    const progressMessage = await api.sendMessage(chatId, t("context.progress"));
    await api.sendChatAction(chatId, "typing").catch(() => {});

    const storedModel = getStoredModel();
    logger.debug(
      `[Compact] Calling summarize with sessionID=${session.id}, directory=${session.directory}, model=${storedModel.providerID}/${storedModel.modelID}`,
    );

    const { error } = await opencodeClient.session.summarize({
      sessionID: session.id,
      directory: session.directory,
      providerID: storedModel.providerID,
      modelID: storedModel.modelID,
    });

    if (error) {
      logger.error("[Compact] Compact failed:", error);
      await api
        .editMessageText(chatId, progressMessage.message_id, t("context.error"))
        .catch(() => {});
      return "api-error";
    }

    logger.info(`[Compact] Session compacted: ${session.id}`);
    await api
      .editMessageText(chatId, progressMessage.message_id, t("context.success"))
      .catch(() => {});
    return "ok";
  } catch (err) {
    logger.error("[Compact] Compact exception:", err);
    return "exception";
  }
}

const lastPercentBySession = new Map<string, number>();

/**
 * Edge-triggered auto-compact decision: fires once when usage crosses the
 * threshold from below, so a session that stays above the line does not
 * compact after every single message.
 */
export function shouldAutoCompact(
  sessionId: string,
  tokensUsed: number,
  tokensLimit: number,
  thresholdPercent: number,
): boolean {
  if (!sessionId || !(thresholdPercent >= 1 && thresholdPercent <= 100)) {
    return false;
  }
  if (!(tokensLimit > 0) || !(tokensUsed >= 0)) {
    return false;
  }
  const percent = (tokensUsed / tokensLimit) * 100;
  const lastPercent = lastPercentBySession.get(sessionId) ?? 0;
  lastPercentBySession.set(sessionId, percent);
  return lastPercent < thresholdPercent && percent >= thresholdPercent;
}

/** Forgets crossing state (e.g. on session switch) so the next climb retriggers. */
export function resetAutoCompactState(sessionId: string): void {
  lastPercentBySession.delete(sessionId);
}
