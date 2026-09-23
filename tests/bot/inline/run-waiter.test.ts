import { beforeEach, describe, expect, it, vi } from "vitest";
import { waitForAssistantCompletion } from "../../../src/bot/inline/run-waiter.js";

const mocked = vi.hoisted(() => ({
  messagesMock: vi.fn(),
  statusMock: vi.fn(),
  questionListMock: vi.fn(),
  permissionListMock: vi.fn(),
  questionRejectMock: vi.fn(),
  permissionReplyMock: vi.fn(),
  abortMock: vi.fn(),
}));

vi.mock("../../../src/opencode/client.js", () => ({
  opencodeClient: {
    session: {
      messages: mocked.messagesMock,
      status: mocked.statusMock,
      abort: mocked.abortMock,
    },
    question: {
      list: mocked.questionListMock,
      reject: mocked.questionRejectMock,
    },
    permission: {
      list: mocked.permissionListMock,
      reply: mocked.permissionReplyMock,
    },
  },
}));

vi.mock("../../../src/utils/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

function assistantMessage(text: string, completed: boolean) {
  return {
    info: { role: "assistant", time: { created: 1, completed: completed ? 2 : undefined } },
    parts: [{ type: "text", text }],
  };
}

describe("bot/inline/run-waiter fail-fast", () => {
  beforeEach(() => {
    mocked.messagesMock.mockReset().mockResolvedValue({ data: [], error: null });
    mocked.statusMock.mockReset().mockResolvedValue({ data: {}, error: null });
    mocked.questionListMock.mockReset().mockResolvedValue({ data: [], error: null });
    mocked.permissionListMock.mockReset().mockResolvedValue({ data: [], error: null });
    mocked.questionRejectMock.mockReset().mockResolvedValue({ error: null });
    mocked.permissionReplyMock.mockReset().mockResolvedValue({ error: null });
    mocked.abortMock.mockReset().mockResolvedValue({ error: null });
  });

  it("rejects, aborts and reports a pending question instead of hanging", async () => {
    mocked.questionListMock.mockResolvedValue({
      data: [{ id: "q-1", sessionID: "session-1" }],
      error: null,
    });

    const result = await waitForAssistantCompletion({
      sessionId: "session-1",
      directory: "D:\\Repo",
      startedAt: 0,
      pollMs: 5,
      failFastOnInteractive: true,
      onProgress: vi.fn().mockResolvedValue(true),
    });

    expect(result).toMatchObject({ completed: false, blocked: "question" });
    expect(mocked.questionRejectMock).toHaveBeenCalledWith({
      requestID: "q-1",
      directory: "D:\\Repo",
    });
    expect(mocked.abortMock).toHaveBeenCalledWith({
      sessionID: "session-1",
      directory: "D:\\Repo",
    });
  });

  it("rejects, aborts and reports a pending permission instead of hanging", async () => {
    mocked.permissionListMock.mockResolvedValue({
      data: [{ id: "p-1", sessionID: "session-1" }],
      error: null,
    });

    const result = await waitForAssistantCompletion({
      sessionId: "session-1",
      directory: "D:\\Repo",
      startedAt: 0,
      pollMs: 5,
      failFastOnInteractive: true,
      onProgress: vi.fn().mockResolvedValue(true),
    });

    expect(result).toMatchObject({ completed: false, blocked: "permission" });
    expect(mocked.permissionReplyMock).toHaveBeenCalledWith({
      requestID: "p-1",
      directory: "D:\\Repo",
      reply: "reject",
      message: expect.any(String),
    });
    expect(mocked.abortMock).toHaveBeenCalledWith({
      sessionID: "session-1",
      directory: "D:\\Repo",
    });
  });

  it("ignores other sessions' pending requests", async () => {
    mocked.questionListMock.mockResolvedValue({
      data: [{ id: "q-9", sessionID: "other-session" }],
      error: null,
    });
    mocked.messagesMock.mockResolvedValue({
      data: [assistantMessage("Done", true)],
      error: null,
    });
    mocked.statusMock
      .mockResolvedValueOnce({ data: { "session-1": { type: "busy" } }, error: null })
      .mockResolvedValue({ data: {}, error: null });

    const result = await waitForAssistantCompletion({
      sessionId: "session-1",
      directory: "D:\\Repo",
      startedAt: 0,
      pollMs: 5,
      failFastOnInteractive: true,
      onProgress: vi.fn().mockResolvedValue(true),
    });

    expect(result).toMatchObject({ text: "Done", completed: true });
    expect(result).not.toHaveProperty("blocked");
    expect(mocked.questionRejectMock).not.toHaveBeenCalled();
    expect(mocked.abortMock).not.toHaveBeenCalled();
  });

  it("keeps waiting when fail-fast is off", async () => {
    mocked.questionListMock.mockResolvedValue({
      data: [{ id: "q-1", sessionID: "session-1" }],
      error: null,
    });

    const result = await waitForAssistantCompletion({
      sessionId: "session-1",
      directory: "D:\\Repo",
      startedAt: 0,
      pollMs: 5,
      timeoutMs: 30,
      onProgress: vi.fn().mockResolvedValue(true),
    });

    expect(result).toBeNull();
    expect(mocked.questionRejectMock).not.toHaveBeenCalled();
    expect(mocked.abortMock).not.toHaveBeenCalled();
  });

  it("returns a fast completed run without ever observing busy", async () => {
    mocked.messagesMock.mockResolvedValue({
      data: [assistantMessage("Quick answer", true)],
      error: null,
    });
    mocked.statusMock.mockResolvedValue({ data: {}, error: null });

    const result = await waitForAssistantCompletion({
      sessionId: "session-1",
      directory: "D:\\Repo",
      startedAt: 0,
      pollMs: 5,
      timeoutMs: 4000,
      onProgress: vi.fn().mockResolvedValue(true),
    });

    expect(result).toMatchObject({ text: "Quick answer", completed: true });
  });

  it("ends immediately when shouldAbort turns true", async () => {
    mocked.messagesMock.mockResolvedValue({
      data: [assistantMessage("Partial", false)],
      error: null,
    });
    let aborted = false;

    const result = await waitForAssistantCompletion({
      sessionId: "session-1",
      directory: "D:\\Repo",
      startedAt: 0,
      pollMs: 5,
      timeoutMs: 4000,
      shouldAbort: () => aborted,
      onProgress: vi.fn().mockImplementation(async () => {
        aborted = true;
        return true;
      }),
    });

    expect(result).toBeNull();
  });

  it("presents new questions once and rejects them after the grace period", async () => {
    mocked.questionListMock.mockResolvedValue({
      data: [
        {
          id: "q-1",
          sessionID: "session-1",
          questions: [
            {
              question: "Pick one?",
              options: [
                { label: "Alpha", description: "first" },
                { label: "Beta", description: "second" },
              ],
            },
          ],
        },
      ],
      error: null,
    });
    const onInteractiveQuestion = vi.fn().mockResolvedValue(undefined);

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-16T10:00:00.000Z"));
    try {
      const resultPromise = waitForAssistantCompletion({
        sessionId: "session-1",
        directory: "D:\\Repo",
        startedAt: 0,
        pollMs: 1000,
        timeoutMs: 10 * 60 * 1000,
        failFastOnInteractive: true,
        onInteractiveQuestion,
        onProgress: vi.fn().mockResolvedValue(true),
      });

      await vi.advanceTimersByTimeAsync(6 * 60 * 1000);
      const result = await resultPromise;

      // Presented exactly once, then rejected after the grace period.
      expect(onInteractiveQuestion).toHaveBeenCalledTimes(1);
      expect(onInteractiveQuestion).toHaveBeenCalledWith({
        id: "q-1",
        questions: [
          {
            question: "Pick one?",
            options: [
              { label: "Alpha", description: "first" },
              { label: "Beta", description: "second" },
            ],
          },
        ],
      });
      expect(result).toMatchObject({ completed: false, blocked: "question" });
      expect(mocked.questionRejectMock).toHaveBeenCalledWith({
        requestID: "q-1",
        directory: "D:\\Repo",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("still rejects permissions immediately when presenting is enabled", async () => {
    mocked.permissionListMock.mockResolvedValue({
      data: [{ id: "p-1", sessionID: "session-1" }],
      error: null,
    });
    const onInteractiveQuestion = vi.fn().mockResolvedValue(undefined);

    const result = await waitForAssistantCompletion({
      sessionId: "session-1",
      directory: "D:\\Repo",
      startedAt: 0,
      pollMs: 5,
      timeoutMs: 4000,
      failFastOnInteractive: true,
      onInteractiveQuestion,
      onProgress: vi.fn().mockResolvedValue(true),
    });

    expect(result).toMatchObject({ completed: false, blocked: "permission" });
    expect(onInteractiveQuestion).not.toHaveBeenCalled();
    expect(mocked.permissionReplyMock).toHaveBeenCalled();
  });

  it("resumes to completion after the question is answered out-of-band", async () => {
    mocked.questionListMock
      .mockResolvedValueOnce({
        data: [
          {
            id: "q-1",
            sessionID: "session-1",
            questions: [{ question: "Pick one?", options: [{ label: "Alpha" }] }],
          },
        ],
        error: null,
      })
      .mockResolvedValue({ data: [], error: null });
    let messageCalls = 0;
    mocked.messagesMock.mockImplementation(async () => {
      messageCalls += 1;
      if (messageCalls < 3) {
        return { data: [], error: null };
      }
      return {
        data: [
          {
            info: { role: "assistant", time: { created: 1, completed: 2 } },
            parts: [{ type: "text", text: "Final answer" }],
          },
        ],
        error: null,
      };
    });
    const onInteractiveQuestion = vi.fn().mockResolvedValue(undefined);

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-16T10:00:00.000Z"));
    try {
      const resultPromise = waitForAssistantCompletion({
        sessionId: "session-1",
        directory: "D:\\Repo",
        startedAt: 0,
        pollMs: 1000,
        timeoutMs: 10 * 60 * 1000,
        failFastOnInteractive: true,
        onInteractiveQuestion,
        onProgress: vi.fn().mockResolvedValue(true),
      });

      await vi.advanceTimersByTimeAsync(30 * 1000);
      const result = await resultPromise;

      expect(onInteractiveQuestion).toHaveBeenCalledTimes(1);
      expect(mocked.questionRejectMock).not.toHaveBeenCalled();
      expect(result).toMatchObject({ text: "Final answer", completed: true });
    } finally {
      vi.useRealTimers();
    }
  });
});
