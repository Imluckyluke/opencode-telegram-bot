import { opencodeClient } from "../../opencode/client.js";
import { logger } from "../../utils/logger.js";
import type { PermissionRuleset } from "@opencode-ai/sdk/v2";

/**
 * Unattended runs cannot answer permission prompts, so their temporary
 * sessions start with tool permissions pre-approved (edit covers write and
 * patch). Questions are denied instead of asked. Anything that still asks
 * (e.g. doom_loop, external_directory) keeps the existing fail-fast path.
 */
export const SCHEDULED_TASK_SESSION_PERMISSIONS: PermissionRuleset = [
  { permission: "edit", pattern: "*", action: "allow" },
  { permission: "bash", pattern: "*", action: "allow" },
  { permission: "task", pattern: "*", action: "allow" },
  { permission: "webfetch", pattern: "*", action: "allow" },
  { permission: "websearch", pattern: "*", action: "allow" },
  { permission: "read", pattern: "*", action: "allow" },
  { permission: "glob", pattern: "*", action: "allow" },
  { permission: "grep", pattern: "*", action: "allow" },
  { permission: "skill", pattern: "*", action: "allow" },
  { permission: "question", pattern: "*", action: "deny" },
];

/**
 * Creates a temporary session for unattended work with pre-approved tool
 * permissions. Falls back to a plain session when the server rejects the
 * ruleset, so older servers keep today's fail-fast behavior.
 */
export async function createUnattendedSession(directory: string, title: string) {
  const withPermissions = await opencodeClient.session.create({
    directory,
    title,
    permission: SCHEDULED_TASK_SESSION_PERMISSIONS,
  });
  if (!withPermissions.error && withPermissions.data) {
    return withPermissions;
  }
  logger.warn(
    "[ScheduledTask] Server rejected the session permission ruleset, retrying without it",
    withPermissions.error,
  );
  return opencodeClient.session.create({ directory, title });
}
