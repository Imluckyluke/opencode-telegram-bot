import { opencodeClient } from "../../opencode/client.js";
import { getCurrentSession } from "../../app/services/session-service.js";
import { questionManager } from "../../app/managers/question-manager.js";
import { permissionManager } from "../../app/managers/permission-manager.js";
import { foregroundSessionState } from "../../app/managers/foreground-session-state-manager.js";
import { assistantRunState } from "../../app/managers/assistant-run-state-manager.js";
import { markAttachedSessionIdle } from "../../app/services/attach-service.js";
import { clearPromptResponseMode } from "../handlers/prompt.js";
import { dropPendingPrompt } from "../handlers/message-merger.js";
import { logger } from "../../utils/logger.js";

function hasPendingPermissionFor(sessionId: string): boolean {
  return permissionManager
    .getMessageIds()
    .some((messageId) => permissionManager.getRequest(messageId)?.sessionID === sessionId);
}

/**
 * Aborts a run of the previous session that is blocked on a question or
 * permission. Once local interaction state is cleared the run can never be
 * answered, so without this the server run hangs forever while local busy
 * tracking stays stuck. Runs without pending Q/P (healthy background runs)
 * are left alone to finish and notify.
 */
async function releaseOrphanedBlockedRun(
  sessionId: string,
  directory: string,
  reason: string,
): Promise<void> {
  try {
    const { error } = await opencodeClient.session.abort({ sessionID: sessionId, directory });
    if (error) {
      logger.warn(
        `[Bot] Session switch cleanup: abort returned an error, releasing local state anyway: session=${sessionId}`,
        error,
      );
    }
  } catch (error) {
    logger.warn(
      `[Bot] Session switch cleanup: abort failed, releasing local state anyway: session=${sessionId}`,
      error,
    );
  }

  foregroundSessionState.markIdle(sessionId);
  assistantRunState.clearRun(sessionId, `switch_cleanup:${reason}`);
  clearPromptResponseMode(sessionId);
  await markAttachedSessionIdle(sessionId);
}

/**
 * Shared hygiene for session/project/fork switches. Buffered merge chunks
 * belong to the previous context: dropping (not flushing) is the only
 * race-free choice, because processUserPrompt resolves the current session
 * when it runs, not when the chunk arrived.
 *
 * Queue and attachment cleanup already lives in setCurrentSession /
 * clearSession; this covers the rest.
 */
export function switchSessionCleanup(chatId: number | null, reason: string): void {
  if (chatId !== null) {
    dropPendingPrompt(chatId);
  }

  // Runs at this point: the current session is still the previous one (all
  // callers switch afterwards).
  const oldSession = getCurrentSession();
  if (!oldSession) {
    return;
  }
  if (!questionManager.isActive() && !hasPendingPermissionFor(oldSession.id)) {
    return;
  }

  logger.warn(
    `[Bot] Session switch cleanup: releasing run blocked on Q/P: session=${oldSession.id}, reason=${reason}`,
  );
  void releaseOrphanedBlockedRun(oldSession.id, oldSession.directory, reason).catch((error) => {
    logger.warn(
      `[Bot] Session switch cleanup: failed to release orphaned run: session=${oldSession.id}`,
      error,
    );
  });
}
