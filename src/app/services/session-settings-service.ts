/**
 * Session Settings Service - adopts the agent and model a session last ran with
 */
import type { Session } from "@opencode-ai/sdk/v2";
import { selectAgent } from "./agent-selection-service.js";
import { selectModel } from "./model-selection-service.js";
import { logger } from "../../utils/logger.js";

// Title prefixes of auxiliary sessions, mirroring INLINE_SESSION_TITLE_PREFIX
// (bot/routers/inline-router.ts) and USER_SESSION_TITLE_PREFIX
// (bot/handlers/user-lane.ts). Kept local to avoid a service -> bot import.
const AUXILIARY_SESSION_TITLE_PREFIXES = ["⚡ ", "Chat "] as const;

function isAuxiliaryLaneSession(title: string | null | undefined): boolean {
  return (
    typeof title === "string" &&
    AUXILIARY_SESSION_TITLE_PREFIXES.some((prefix) => title.startsWith(prefix))
  );
}

/**
 * Apply the agent and model stored on a session to the current settings.
 * Agent and model are adopted independently: a session that carries only one of
 * them changes only that one, and a session that was never prompted changes
 * nothing. The variant is part of the model record and is never adopted on its
 * own, so a model without a variant is stored at "default".
 *
 * Auxiliary sessions (guest "⚡ …" runs and personal "Chat …" lanes) always
 * run with the guest model: adopting their model would silently replace the
 * DM default with the guest default, and neither /new nor /detach could bring
 * it back. Opening them leaves global settings untouched.
 * @param session Session to read the settings from
 */
export function applySessionSettings(session: Session): void {
  if (isAuxiliaryLaneSession(session.title)) {
    logger.debug(`[SessionSettings] Skipping adoption for auxiliary session ${session.id}`);
    return;
  }

  const model = session.model;

  if (session.agent) {
    selectAgent(session.agent);
  }

  if (model?.providerID && model.id) {
    selectModel({
      providerID: model.providerID,
      modelID: model.id,
      variant: model.variant || "default",
    });
  }

  if (!session.agent && !model) {
    logger.debug(`[SessionSettings] Session ${session.id} carries no agent or model to pull`);
    return;
  }

  logger.info(
    `[SessionSettings] Pulled from session ${session.id}: agent=${session.agent ?? "unchanged"}, model=${
      model?.providerID && model.id
        ? `${model.providerID}/${model.id} (${model.variant || "default"})`
        : "unchanged"
    }`,
  );
}
