const TELEGRAM_NOTE =
  "You are communicating with the user via Telegram through the opencode-telegram-bot. " +
  "Keep answers concise and Telegram-friendly. " +
  "Write tables as Markdown tables and use Markdown lists/quotes — the client renders them as native Telegram rich blocks (real tables, never ASCII art). " +
  "You may ask clarifying questions as a short numbered list of options — in group chats they can be answered by tapping an in-message button or replying with just the option number. " +
  "When writing code against Telegram Bot API 10.3, rich messages support blocks (paragraph/heading/pre/footer/divider/list/quotes/collage/table/details/media incl. document/photo/video/audio/voice/thinking/buttons/expandable-quote) with in-text buttons as {type:'buttons',buttons:[{text,callback_data}]}, bordered/striped/compact tables, and inline documents — see https://core.telegram.org/bots/api." +
  " The user reads you on Telegram from their phone and cannot open local file paths, so never present a bare path as the deliverable and do not paste full file contents into the chat (chat text never becomes a downloadable file). When you create or modify files, always write them with your file tools: the client uploads each written file as a Telegram document automatically. Keep the reply itself to a short summary naming the files."
const GITHUB_NOTE =
  "The environment has GH_TOKEN (plus GIT_USER_NAME/GIT_USER_EMAIL) available, " +
  "so git push to GitHub works when needed.";

/** Kept for backwards compatibility; prefer buildDefaultContextNote(). */
export const DEFAULT_AGENT_CONTEXT_NOTE = `${TELEGRAM_NOTE} ${GITHUB_NOTE}`;

export interface AgentContextOptions {
  /** Include the GitHub token sentence. Defaults to true. */
  github?: boolean | undefined;
}

/** Default note; mentions GitHub push only when GH_TOKEN is actually set. */
export function buildDefaultContextNote(opts?: AgentContextOptions): string {
  const includeGithub = opts?.github !== false && Boolean(process.env.GH_TOKEN?.trim());
  if (includeGithub) {
    return `${TELEGRAM_NOTE} ${GITHUB_NOTE}`;
  }
  return TELEGRAM_NOTE;
}

function isDisabledNote(value: string): boolean {
  return ["0", "false", "no", "off", "disabled"].includes(value.trim().toLowerCase());
}

export interface AgentContextOptions {
  /** Include the GitHub token sentence. Defaults to true. */
  github?: boolean | undefined;
}

/** Prepends the default agent context unless disabled. */
export function withAgentContext(
  text: string,
  note?: string,
  opts?: AgentContextOptions,
): string {
  const env = process.env.AGENT_CONTEXT_NOTE;
  const raw = note ?? (env ? env : buildDefaultContextNote(opts));
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
