/**
 * Shared run state for inline/guest asks. Kept in a leaf module (no imports)
 * so commands like /deletesessions can cancel stuck runs without pulling the
 * whole router dependency graph.
 *
 * Runs are keyed so independent chats proceed in parallel: guest asks use one
 * key per chat, inline taps share a global key. A key is held from prompt
 * dispatch until its answer stream settles.
 */
export const GLOBAL_RUN_KEY = "inline:global";

const inFlightKeys = new Set<string>();
// Bumped to abandon in-flight waits (e.g. on session wipe); each waiter only
// honors the generation it started with.
let inlineRunGeneration = 0;

/** Key for guest asks in a chat; inline taps share the global key. */
export function guestRunKey(chatId: number | null): string {
  return chatId === null ? GLOBAL_RUN_KEY : `guest:${chatId}`;
}

export function isInlineRunInFlight(key: string = GLOBAL_RUN_KEY): boolean {
  return inFlightKeys.has(key);
}

export function setInlineRunInFlight(inFlight: boolean, key: string = GLOBAL_RUN_KEY): void {
  if (inFlight) {
    inFlightKeys.add(key);
  } else {
    inFlightKeys.delete(key);
  }
}

export function currentInlineRunGeneration(): number {
  return inlineRunGeneration;
}

/**
 * Releases stuck inline/guest runs: in-flight waits end at the next poll and
 * new asks are accepted immediately. Called when all server sessions are
 * wiped, since those runs can never complete anymore.
 */
export function cancelInlineRuns(): void {
  inlineRunGeneration += 1;
  inFlightKeys.clear();
}

/** Test helper: resets module state. */
export function __resetInlineRunStateForTests(): void {
  inFlightKeys.clear();
  inlineRunGeneration = 0;
}
