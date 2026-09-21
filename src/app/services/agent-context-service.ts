const TELEGRAM_NOTE =
  "You are communicating with the user via Telegram through the opencode-telegram-bot. " +
  "Keep answers concise and Telegram-friendly. " +
  "Write tables as Markdown tables and use Markdown lists/quotes — the client renders them as native Telegram rich blocks (real tables, never ASCII art).";
const GITHUB_NOTE =
  "The environment has GH_TOKEN (plus GIT_USER_NAME/GIT_USER_EMAIL) available, " +
  "so git push to GitHub works when needed.";

/** Kept for backwards compatibility; prefer buildDefaultContextNote(). */
export const DEFAULT_AGENT_CONTEXT_NOTE = `${TELEGRAM_NOTE} ${GITHUB_NOTE}`;

/** Default note; mentions GitHub push only when GH_TOKEN is actually set. */
export function buildDefaultContextNote(): string {
  if (process.env.GH_TOKEN?.trim()) {
    return `${TELEGRAM_NOTE} ${GITHUB_NOTE}`;
  }
  return TELEGRAM_NOTE;
}

function isDisabledNote(value: string): boolean {
  return ["0", "false", "no", "off", "disabled"].includes(value.trim().toLowerCase());
}

/** Prepends the default agent context (Telegram + GH_TOKEN) unless disabled. */
export function withAgentContext(text: string, note?: string): string {
  const env = process.env.AGENT_CONTEXT_NOTE;
  const raw = note ?? (env ? env : buildDefaultContextNote());
  if (!raw.trim() || isDisabledNote(raw)) {
    return text;
  }
  const resolved = (note ?? raw).trim();
  if (!text.trim()) {
    return `[Note: ${resolved}]`;
  }
  return `[Note: ${resolved}]\n${text}`;
}

const LEADING_NOTE_PREFIX_PATTERN = /^\[Note:[^\n\]]*\]\n?/;

/** Removes our injected leading [Note: ...] line(s) so users never see them. */
export function stripAgentContext(text: string): string {
  let stripped = text;
  let previous = "";
  while (previous !== stripped) {
    previous = stripped;
    stripped = stripped.replace(LEADING_NOTE_PREFIX_PATTERN, "");
  }
  return stripped;
}
