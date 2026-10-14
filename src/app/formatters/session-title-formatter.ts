import { t } from "../../i18n/index.js";

/**
 * Name a session is shown under. OpenCode V2 leaves a new session untitled until
 * it names it after the first prompt; until then it reads like the dashboard's.
 */
export function formatSessionTitle(title: string): string {
  return title || t("pinned.default_session_title");
}
