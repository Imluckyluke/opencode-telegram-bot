export const DEFAULT_AGENT_CONTEXT_NOTE =
  "You are communicating with the user via Telegram through the opencode-telegram-bot. " +
  "Keep answers concise and Telegram-friendly. " +
  "The environment has GH_TOKEN (plus GIT_USER_NAME/GIT_USER_EMAIL) available, so git push to GitHub works when needed.";

/** Prepends the default agent context (Telegram + GH_TOKEN) unless disabled. */
export function withAgentContext(text: string, note?: string): string {
  const env = process.env.AGENT_CONTEXT_NOTE;
  const raw = note ?? (env ? env : DEFAULT_AGENT_CONTEXT_NOTE);
  const trimmed = raw.trim();
  if (!trimmed) {
    return text;
  }
  if (["0", "false", "no", "off", "disabled"].includes(trimmed.toLowerCase())) {
    return text;
  }
  const resolved = note ?? trimmed;
  if (!text.trim()) {
    return `[Note: ${resolved}]`;
  }
  return `[Note: ${resolved}]\n${text}`;
}
