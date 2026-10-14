const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;

const TEN_MINUTES_MS = 10 * MINUTE_MS;
const FIVE_MINUTES_MS = 5 * MINUTE_MS;
const FIFTEEN_MINUTES_MS = 15 * MINUTE_MS;
const TEN_SECONDS_MS = 10 * SECOND_MS;

/** Tool calls shorter than this are rendered exactly as before, without elapsed time. */
export const TOOL_ELAPSED_THRESHOLD_MS = 20 * SECOND_MS;

/** Prefix every rendered duration shares with the assistant run footer. */
export const DURATION_ICON = "🕒";

/** Marks a step that is still running, as the compact progress header does. */
export const RUNNING_ICON = "⏳";

/**
 * Appends a duration the way the assistant run footer does. Composed in code
 * rather than through i18n: there is no word to translate, only placeholders,
 * a separator and two icons.
 */
export function appendDuration(text: string, elapsed: string): string {
  return `${text} · ${DURATION_ICON} ${elapsed}`;
}

/** Same as appendDuration, on the first line of a message that lists several. */
export function appendDurationToFirstLine(text: string, elapsed: string): string {
  const lineEnd = text.indexOf("\n");
  if (lineEnd < 0) {
    return appendDuration(text, elapsed);
  }

  return `${appendDuration(text.slice(0, lineEnd), elapsed)}${text.slice(lineEnd)}`;
}

function floorTo(value: number, step: number): number {
  return Math.floor(value / step) * step;
}

/**
 * Shared duration format: `1h 2m 3s`. Originally written for the assistant run
 * footer and kept here so every place that shows a duration reads the same.
 */
export function formatDuration(elapsedMs: number): string {
  const safeElapsedMs = Math.max(0, Math.round(elapsedMs));
  const totalSeconds = Math.floor(safeElapsedMs / 1000);

  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (seconds > 0 || parts.length === 0) parts.push(`${seconds}s`);

  return parts.join(" ");
}

/** Reads as "longer than N hours" in the same notation, e.g. `>24h`. */
export function formatDurationOverHours(hours: number): string {
  return `>${hours}h`;
}

/**
 * Rounds elapsed time down to a display step that grows with the value. Live
 * timers are rendered from the bucketed value, so the message is only edited
 * when the shown number actually changes.
 */
export function bucketElapsedMs(elapsedMs: number): number {
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) {
    return 0;
  }

  if (elapsedMs < MINUTE_MS) {
    return floorTo(elapsedMs, TEN_SECONDS_MS);
  }

  if (elapsedMs < TEN_MINUTES_MS) {
    return floorTo(elapsedMs, MINUTE_MS);
  }

  if (elapsedMs < HOUR_MS) {
    return floorTo(elapsedMs, FIVE_MINUTES_MS);
  }

  return floorTo(elapsedMs, FIFTEEN_MINUTES_MS);
}
