import {
  SCHEDULED_TASK_SESSION_PERMISSIONS,
  createSessionWithPermissions,
} from "./session-permissions.js";

/**
 * Creates a temporary session for unattended work with pre-approved tool
 * permissions. Falls back to a plain session when the server rejects the
 * ruleset, so older servers keep today's fail-fast behavior.
 */
export async function createUnattendedSession(directory: string, title: string) {
  return createSessionWithPermissions(directory, title, SCHEDULED_TASK_SESSION_PERMISSIONS);
}
