import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { Context } from "grammy";
import { createIncomingPrompt } from "../../../src/app/types/prompt.js";

const processUserPromptMock = vi.hoisted(() => vi.fn());
const sessionAbortMock = vi.hoisted(() => vi.fn());
const getCurrentSessionMock = vi.hoisted(() => vi.fn());
const markAttachedSessionIdleMock = vi.hoisted(() => vi.fn());

vi.mock("../../../src/bot/handlers/prompt.js", () => ({
  processUserPrompt: processUserPromptMock,
  clearPromptResponseMode: vi.fn(),
}));

vi.mock("../../../src/opencode/client.js", () => ({
  opencodeClient: { session: { abort: sessionAbortMock } },
}));

vi.mock("../../../src/app/services/session-service.js", () => ({
  getCurrentSession: getCurrentSessionMock,
}));

vi.mock("../../../src/app/services/attach-service.js", () => ({
  markAttachedSessionIdle: markAttachedSessionIdleMock,
}));

vi.mock("../../../src/utils/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { queuePromptForMerging } from "../../../src/bot/handlers/message-merger.js";
import { switchSessionCleanup } from "../../../src/bot/services/session-switch-cleanup.js";
import { __resetMessageMergerForTests } from "../../../src/bot/handlers/message-merger.js";
import { questionManager } from "../../../src/app/managers/question-manager.js";
import { permissionManager } from "../../../src/app/managers/permission-manager.js";
import { foregroundSessionState } from "../../../src/app/managers/foreground-session-state-manager.js";

const DEPS = { bot: {} as never, ensureEventSubscription: vi.fn() };
const LARGE_TEXT = "x".repeat(4000);

describe("bot/services/session-switch-cleanup", () => {
  beforeEach(() => {
    __resetMessageMergerForTests();
    processUserPromptMock.mockReset().mockResolvedValue(true);
    sessionAbortMock.mockReset().mockResolvedValue({ data: true, error: null });
    getCurrentSessionMock.mockReset().mockReturnValue(null);
    markAttachedSessionIdleMock.mockReset().mockResolvedValue(undefined);
    permissionManager.clear();
    questionManager.clear();
    foregroundSessionState.__resetForTests();
    vi.useFakeTimers();
  });

  afterEach(() => {
    __resetMessageMergerForTests();
    permissionManager.clear();
    questionManager.clear();
    foregroundSessionState.__resetForTests();
    vi.useRealTimers();
  });

  it("drops a buffered merge chunk so it cannot fire after the switch", () => {
    const ctx = { chat: { id: 7 } } as unknown as Context;
    queuePromptForMerging(ctx, createIncomingPrompt(LARGE_TEXT), DEPS, 1500);

    switchSessionCleanup(7, "session_selected");
    vi.advanceTimersByTime(5000);

    expect(processUserPromptMock).not.toHaveBeenCalled();
  });

  it("ignores a null chat id", () => {
    switchSessionCleanup(null, "session_selected");
    vi.advanceTimersByTime(5000);

    expect(processUserPromptMock).not.toHaveBeenCalled();
  });

  it("aborts the old run and releases busy state when a permission is pending", async () => {
    getCurrentSessionMock.mockReturnValue({ id: "s-1", title: "Old", directory: "D:/Repo" });
    permissionManager.startPermission(
      {
        id: "perm-1",
        sessionID: "s-1",
        permission: "bash",
        patterns: ["rm"],
        metadata: {},
        always: [],
      },
      555,
    );
    foregroundSessionState.markBusy("s-1", "D:/Repo");

    switchSessionCleanup(7, "session_selected");
    await vi.waitFor(() => {
      expect(sessionAbortMock).toHaveBeenCalledWith({ sessionID: "s-1", directory: "D:/Repo" });
    });

    expect(foregroundSessionState.isBusy()).toBe(false);
    expect(markAttachedSessionIdleMock).toHaveBeenCalledWith("s-1");
  });

  it("aborts the old run when a question is pending", async () => {
    getCurrentSessionMock.mockReturnValue({ id: "s-1", title: "Old", directory: "D:/Repo" });
    questionManager.startQuestions(
      [{ question: "Proceed?", header: "", options: [{ label: "Yes", description: "" }] }] as never,
      "q-1",
    );

    switchSessionCleanup(7, "session_selected");
    await vi.waitFor(() => {
      expect(sessionAbortMock).toHaveBeenCalledWith({ sessionID: "s-1", directory: "D:/Repo" });
    });
  });

  it("leaves healthy background runs alone when nothing is pending", () => {
    getCurrentSessionMock.mockReturnValue({ id: "s-1", title: "Old", directory: "D:/Repo" });
    foregroundSessionState.markBusy("s-1", "D:/Repo");

    switchSessionCleanup(7, "session_selected");

    expect(sessionAbortMock).not.toHaveBeenCalled();
    expect(foregroundSessionState.isBusy()).toBe(true);
  });

  it("ignores pending permissions of other sessions", () => {
    getCurrentSessionMock.mockReturnValue({ id: "s-1", title: "Old", directory: "D:/Repo" });
    permissionManager.startPermission(
      {
        id: "perm-9",
        sessionID: "s-9",
        permission: "bash",
        patterns: ["rm"],
        metadata: {},
        always: [],
      },
      556,
    );

    switchSessionCleanup(7, "session_selected");

    expect(sessionAbortMock).not.toHaveBeenCalled();
  });
});
