import { opencodeClient } from "../../opencode/client.js";
import { logger } from "../../utils/logger.js";
import type { PermissionRuleset } from "@opencode-ai/sdk/v2";

/**
 * Tool approvals shared by every unattended-style session (scheduled tasks,
 * guest summons, personal lanes): nobody is around to tap an approval, so
 * the session starts pre-approved. `edit` covers `write` and `patch`.
 */
const UNATTENDED_TOOL_ALLOW_RULES: PermissionRuleset = [
  { permission: "edit", pattern: "*", action: "allow" },
  { permission: "bash", pattern: "*", action: "allow" },
  { permission: "task", pattern: "*", action: "allow" },
  { permission: "webfetch", pattern: "*", action: "allow" },
  { permission: "websearch", pattern: "*", action: "allow" },
  { permission: "read", pattern: "*", action: "allow" },
  { permission: "glob", pattern: "*", action: "allow" },
  { permission: "grep", pattern: "*", action: "allow" },
  { permission: "skill", pattern: "*", action: "allow" },
];

/** Scheduled tasks and personal lanes: questions can never be answered there. */
const DENY_QUESTION_RULE: PermissionRuleset = [{ permission: "question", pattern: "*", action: "deny" }];

/** Scheduled task runs: fully unattended. */
export const SCHEDULED_TASK_SESSION_PERMISSIONS: PermissionRuleset = [
  ...UNATTENDED_TOOL_ALLOW_RULES,
  ...DENY_QUESTION_RULE,
];

/**
 * Guest summons: same pre-approvals, but questions stay askable — the group
 * answers them through the numbered question flow.
 */
export const GUEST_SESSION_PERMISSIONS: PermissionRuleset = [...UNATTENDED_TOOL_ALLOW_RULES];

/** Personal lanes have no question UI, so questions are denied like tasks. */
export const USER_LANE_SESSION_PERMISSIONS: PermissionRuleset = [
  ...UNATTENDED_TOOL_ALLOW_RULES,
  ...DENY_QUESTION_RULE,
];

/**
 * Creates a session with the given permission ruleset. Falls back to a plain
 * session when the server rejects the ruleset, so older servers keep the
 * previous fail-fast behavior instead of breaking session creation.
 */
export async function createSessionWithPermissions(
  directory: string,
  title: string,
  permission: PermissionRuleset,
) {
  const withPermissions = await opencodeClient.session.create({
    directory,
    title,
    permission,
  });
  if (!withPermissions.error && withPermissions.data) {
    return withPermissions;
  }
  logger.warn(
    "[Sessions] Server rejected the session permission ruleset, retrying without it",
    withPermissions.error,
  );
  return opencodeClient.session.create({ directory, title });
}
