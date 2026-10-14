import { getStoredModel } from "../../app/services/model-selection-service.js";
import { keyboardManager } from "../keyboards/keyboard-manager.js";
import { pinnedMessageManager } from "../pinned/pinned-message-manager.js";
import { logger } from "../../utils/logger.js";

/** Redraws what shows the selected model: the pinned dashboard and the keyboard model button. */
export async function refreshModelViews(): Promise<void> {
  await pinnedMessageManager.refreshContextLimit();
  await pinnedMessageManager.refresh();
  if (keyboardManager.isInitialized()) {
    keyboardManager.updateModel(getStoredModel());
  }
  logger.info("[Bot] Refreshed model views");
}
