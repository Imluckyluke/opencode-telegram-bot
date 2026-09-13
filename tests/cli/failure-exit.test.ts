import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { defined } from "../helpers/defined.js";

const mocked = vi.hoisted(() => ({
  flushLoggerMock: vi.fn(),
}));

vi.mock("../../src/utils/logger.js", () => ({
  flushLogger: mocked.flushLoggerMock,
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { handleCliFailure } from "../../src/cli/failure-exit.js";

describe("cli/failure-exit", () => {
  let processExitSpy: MockInstance;
  let stderrSpy: MockInstance;

  beforeEach(() => {
    mocked.flushLoggerMock.mockReset();
    mocked.flushLoggerMock.mockResolvedValue(undefined);
    processExitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as unknown as typeof process.exit);
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation((() => true) as unknown as typeof process.stderr.write);
  });

  afterEach(() => {
    processExitSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  it("writes the CLI error, flushes the log, then exits 1", async () => {
    const error = new Error("Network request for 'getWebhookInfo' failed!");

    await handleCliFailure(error);

    expect(stderrSpy).toHaveBeenCalledWith("CLI error: Network request for 'getWebhookInfo' failed!\n");
    expect(mocked.flushLoggerMock).toHaveBeenCalledTimes(1);
    expect(processExitSpy).toHaveBeenCalledWith(1);
    expect(defined(processExitSpy.mock.invocationCallOrder[0])).toBeGreaterThan(
      defined(mocked.flushLoggerMock.mock.invocationCallOrder[0]),
    );
  });

  it("exits 1 when the log flush hangs past the bound", async () => {
    vi.useFakeTimers();
    mocked.flushLoggerMock.mockReturnValue(new Promise(() => undefined));

    const done = handleCliFailure(new Error("boom"));
    await vi.advanceTimersByTimeAsync(1000);
    await done;

    expect(processExitSpy).toHaveBeenCalledWith(1);
    vi.useRealTimers();
  });
});
