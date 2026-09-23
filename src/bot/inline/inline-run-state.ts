/**
 * Shared run state for inline/guest asks. Kept in a leaf module (no imports)
 * so commands like /deletesessions can cancel stuck runs without pulling the
 * whole router dependency graph.
 */
let inlineRunInFlight = false;
// Bumped to abandon in-flight waits (e.g. on session wipe); each waiter only
// honors the generation it started with.
let inlineRunGeneration = 0;

export function isInlineRunInFlight(): boolean {
  return inlineRunInFlight;
}

export function setInlineRunInFlight(inFlight: boolean): void {
  inlineRunInFlight = inFlight;
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
  inlineRunInFlight = false;
}

/** Test helper: resets module state. */
export function __resetInlineRunStateForTests(): void {
  inlineRunInFlight = false;
  inlineRunGeneration = 0;
}
