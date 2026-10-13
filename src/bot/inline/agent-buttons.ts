import { randomBytes } from "node:crypto";

/**
 * Agent-authored in-text buttons (Bot API 10.3 rich messages).
 *
 * The agent writes a markdown link `[label](btn:value)`; the render layer
 * turns it into an inline button, and tapping it injects `value` as the
 * user's next prompt. Short values ride inside `callback_data` (1-64 bytes),
 * longer ones are kept in a small in-memory overflow table.
 */

/** Callback prefix for taps carrying the value inline. */
export const AGENT_BUTTON_CALLBACK_PREFIX = "ab";

/** Callback prefix for taps referencing the overflow table. */
export const AGENT_BUTTON_KEY_PREFIX = "abk";

/** Link scheme the agent uses to author a button: `[label](btn:value)`. */
export const AGENT_BUTTON_URL_SCHEME = "btn:";

/** Bytes of `ab:` leave this budget for the value inside callback_data. */
const MAX_INLINE_VALUE_BYTES = 56;

/** Button labels longer than this are cut; Telegram rejects huge buttons. */
export const MAX_AGENT_BUTTON_LABEL_CHARS = 64;

const OVERFLOW_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_OVERFLOW_ENTRIES = 200;

interface OverflowEntry {
  value: string;
  createdAt: number;
}

const overflowByKey = new Map<string, OverflowEntry>();

export function isAgentButtonUrl(url: string): boolean {
  return url.startsWith(AGENT_BUTTON_URL_SCHEME);
}

/** The tap payload of a `btn:` link; falls back to the label when empty. */
export function agentButtonValueFromUrl(url: string, label: string): string {
  const raw = url.slice(AGENT_BUTTON_URL_SCHEME.length).trim();
  return raw ? raw : label;
}

function pruneOverflow(now: number): void {
  for (const [key, entry] of overflowByKey) {
    if (now - entry.createdAt > OVERFLOW_TTL_MS) {
      overflowByKey.delete(key);
    }
  }
  while (overflowByKey.size > MAX_OVERFLOW_ENTRIES) {
    const oldest = overflowByKey.keys().next();
    if (oldest.done) {
      break;
    }
    overflowByKey.delete(oldest.value);
  }
}

/** Builds the `callback_data` for a button tap. */
export function encodeAgentButtonCallback(value: string): string {
  if (Buffer.byteLength(value, "utf8") <= MAX_INLINE_VALUE_BYTES) {
    return `${AGENT_BUTTON_CALLBACK_PREFIX}:${value}`;
  }

  const now = Date.now();
  pruneOverflow(now);
  const key = randomBytes(9).toString("base64url");
  overflowByKey.set(key, { value, createdAt: now });
  return `${AGENT_BUTTON_KEY_PREFIX}:${key}`;
}

export type ParsedAgentButtonCallback =
  { kind: "inline"; value: string } | { kind: "key"; id: string } | null;

export function parseAgentButtonCallback(data: string): ParsedAgentButtonCallback {
  if (data.startsWith(`${AGENT_BUTTON_CALLBACK_PREFIX}:`)) {
    const value = data.slice(AGENT_BUTTON_CALLBACK_PREFIX.length + 1);
    return value ? { kind: "inline", value } : null;
  }
  if (data.startsWith(`${AGENT_BUTTON_KEY_PREFIX}:`)) {
    const id = data.slice(AGENT_BUTTON_KEY_PREFIX.length + 1);
    return id ? { kind: "key", id } : null;
  }
  return null;
}

/** Resolves a parsed tap to the prompt text, or null when stale/unknown. */
export function resolveAgentButtonValue(parsed: ParsedAgentButtonCallback): string | null {
  if (!parsed) {
    return null;
  }
  if (parsed.kind === "inline") {
    return parsed.value;
  }
  const entry = overflowByKey.get(parsed.id);
  if (!entry || Date.now() - entry.createdAt > OVERFLOW_TTL_MS) {
    overflowByKey.delete(parsed.id);
    return null;
  }
  return entry.value;
}

/** Test helper: resets module state. */
export function __resetAgentButtonOverflowForTests(): void {
  overflowByKey.clear();
}
