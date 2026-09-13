import { flushLogger } from "../utils/logger.js";

const LOG_FLUSH_TIMEOUT_MS = 1000;
const EXIT_RUNTIME_ERROR = 1;

export async function handleCliFailure(error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`CLI error: ${message}\n`);

  await Promise.race([
    flushLogger().catch(() => {}),
    new Promise<void>((resolve) => setTimeout(resolve, LOG_FLUSH_TIMEOUT_MS)),
  ]);

  process.exit(EXIT_RUNTIME_ERROR);
}
