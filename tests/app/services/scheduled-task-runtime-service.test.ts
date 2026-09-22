import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot, Context } from "grammy";
import type { ScheduledTask } from "../../../src/app/types/scheduled-task.js";
import { defined } from "../../helpers/defined.js";

const mocked = vi.hoisted(() => ({
  tasks: [] as ScheduledTask[],
  executeScheduledTaskMock: vi.fn(),
  sendBotTextMock: vi.fn(),
  replaceScheduledTasksMock: vi.fn(),
  removeScheduledTaskMock: vi.fn(),
  cleanupIgnoresMock: vi.fn(),
}));

function cloneTask(task: ScheduledTask): ScheduledTask {
  return {
    ...task,
    model: { ...task.model },
  };
}

vi.mock("../../../src/config.js", () => ({
  config: {
    telegram: {
      allowedUserId: 777,
    },
    bot: {
      messageFormatMode: "markdown",
    },
    opencode: {
      apiUrl: "http://localhost:4096",
      password: "",
    },
    server: {
      logLevel: "error",
    },
  },
}));

vi.mock("../../../src/opencode/client.js", () => ({
  opencodeClient: {
    session: {
      create: vi.fn(),
      prompt: vi.fn(),
      promptAsync: vi.fn(),
      delete: vi.fn(),
    },
  },
}));

vi.mock("../../../src/app/services/scheduled-task-executor-service.js", () => ({
  executeScheduledTask: mocked.executeScheduledTaskMock,
}));

vi.mock("../../../src/app/services/scheduled-task-session-ignore-service.js", () => ({
  cleanupScheduledTaskSessionIgnores: mocked.cleanupIgnoresMock,
}));

vi.mock("../../../src/bot/messages/telegram-text.js", () => ({
  sendBotText: mocked.sendBotTextMock,
}));

vi.mock("../../../src/app/stores/scheduled-task-store.js", () => ({
  listScheduledTasks: vi.fn(() => mocked.tasks.map((task) => cloneTask(task))),
  getScheduledTask: vi.fn((taskId: string) => {
    const task = mocked.tasks.find((item) => item.id === taskId);
    return task ? cloneTask(task) : null;
  }),
  replaceScheduledTasks: vi.fn(async (tasks: ScheduledTask[]) => {
    mocked.tasks = tasks.map((task) => cloneTask(task));
    mocked.replaceScheduledTasksMock(tasks);
  }),
  updateScheduledTask: vi.fn(
    async (taskId: string, updater: (task: ScheduledTask) => ScheduledTask) => {
      const index = mocked.tasks.findIndex((task) => task.id === taskId);
      if (index < 0) {
        return null;
      }

      const nextTask = cloneTask(updater(cloneTask(defined(mocked.tasks[index]))));
      mocked.tasks[index] = nextTask;
      return cloneTask(nextTask);
    },
  ),
  removeScheduledTask: vi.fn(async (taskId: string) => {
    const nextTasks = mocked.tasks.filter((task) => task.id !== taskId);
    const removed = nextTasks.length !== mocked.tasks.length;
    mocked.tasks = nextTasks;
    mocked.removeScheduledTaskMock(taskId);
    return removed;
  }),
}));

function createTask(partial: Partial<ScheduledTask> = {}): ScheduledTask {
  const kind = partial.kind ?? "once";

  if (kind === "cron") {
    return {
      id: "task-1",
      kind: "cron",
      projectId: "project-1",
      projectWorktree: "D:\\Projects\\Repo",
      agent: "build",
      model: {
        providerID: "openai",
        modelID: "gpt-5",
        variant: "default",
      },
      scheduleText: "every day at 17:00",
      scheduleSummary: "Every day at 17:00",
      timezone: "UTC",
      cron: "0 17 * * *",
      prompt: "Send report",
      createdAt: "2026-03-16T10:00:00.000Z",
      nextRunAt: "2026-03-16T10:00:00.000Z",
      lastRunAt: null,
      runCount: 0,
      lastStatus: "idle",
      lastError: null,
      ...partial,
    } as ScheduledTask;
  }

  return {
    id: "task-1",
    kind: "once",
    projectId: "project-1",
    projectWorktree: "D:\\Projects\\Repo",
    agent: "build",
    model: {
      providerID: "openai",
      modelID: "gpt-5",
      variant: "default",
    },
    scheduleText: "tomorrow at 12:00",
    scheduleSummary: "Tomorrow at 12:00",
    timezone: "UTC",
    runAt: "2026-03-16T10:00:00.000Z",
    prompt: "Send report",
    createdAt: "2026-03-16T09:00:00.000Z",
    nextRunAt: "2026-03-16T10:00:00.000Z",
    lastRunAt: null,
    runCount: 0,
    lastStatus: "idle",
    lastError: null,
    ...partial,
  } as ScheduledTask;
}

async function createDeliverySender() {
  const { createScheduledTaskDeliverySender } = await import(
    "../../../src/bot/messages/scheduled-task-delivery.js"
  );

  return createScheduledTaskDeliverySender({ sendMessage: vi.fn() } as never, 777);
}

describe("app/services/scheduled-task-runtime-service", () => {
  let ScheduledTaskRuntimeClass: typeof import("../../../src/app/services/scheduled-task-runtime-service.js").ScheduledTaskRuntime;
  let foregroundSessionState: typeof import("../../../src/app/managers/foreground-session-state-manager.js").foregroundSessionState;

  beforeEach(() => {
    mocked.tasks = [];
    mocked.executeScheduledTaskMock.mockReset();
    mocked.sendBotTextMock.mockReset();
    mocked.replaceScheduledTasksMock.mockReset();
    mocked.removeScheduledTaskMock.mockReset();
    mocked.cleanupIgnoresMock.mockReset();
    mocked.cleanupIgnoresMock.mockResolvedValue(0);
  });

  it("queues scheduled task result while foreground session is busy and flushes later", async () => {
    ({ ScheduledTaskRuntime: ScheduledTaskRuntimeClass } =
      await import("../../../src/app/services/scheduled-task-runtime-service.js"));
    ({ foregroundSessionState } = await import("../../../src/app/managers/foreground-session-state-manager.js"));
    foregroundSessionState.__resetForTests();

    const runtime = new ScheduledTaskRuntimeClass();
    mocked.tasks = [createTask({ nextRunAt: "2026-03-16T09:59:00.000Z" })];
    mocked.executeScheduledTaskMock.mockResolvedValue({
      taskId: "task-1",
      status: "success",
      startedAt: "2026-03-16T10:00:00.000Z",
      finishedAt: "2026-03-16T10:01:00.000Z",
      resultText: "All good",
      errorMessage: null,
    });

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-16T10:00:00.000Z"));
    foregroundSessionState.markBusy("session-1", "D:\\Projects\\Repo");

    await runtime.initialize({ api: {} } as Bot<Context>, await createDeliverySender());

    expect(mocked.cleanupIgnoresMock).toHaveBeenCalledTimes(1);
    await vi.runAllTimersAsync();

    expect(mocked.removeScheduledTaskMock).toHaveBeenCalledWith("task-1");
    expect(mocked.sendBotTextMock).not.toHaveBeenCalled();

    foregroundSessionState.markIdle("session-1");
    await runtime.flushDeferredDeliveries();

    expect(mocked.sendBotTextMock).toHaveBeenCalledTimes(2);
    expect(mocked.sendBotTextMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        chatId: 777,
        format: "markdown_v2",
        options: { disable_notification: true },
        text: expect.stringMatching(/Send report[\s\S]*All good/),
      }),
    );
    const footerCall = (mocked.sendBotTextMock as ReturnType<typeof vi.fn>).mock.calls[1]?.[0];
    expect(footerCall).toEqual(
      expect.objectContaining({
        chatId: 777,
        format: "raw",
        text: "🛠️ Build · 🧠 openai/gpt-5 · 🕒 1m",
      }),
    );
    expect(footerCall).not.toHaveProperty("options");

    runtime.__resetForTests();
    vi.useRealTimers();
  });

  it("keeps recurring task after execution error and schedules next run", async () => {
    ({ ScheduledTaskRuntime: ScheduledTaskRuntimeClass } =
      await import("../../../src/app/services/scheduled-task-runtime-service.js"));
    ({ foregroundSessionState } = await import("../../../src/app/managers/foreground-session-state-manager.js"));
    foregroundSessionState.__resetForTests();

    const runtime = new ScheduledTaskRuntimeClass();
    mocked.tasks = [createTask({ kind: "cron", nextRunAt: "2026-03-16T16:59:00.000Z" })];
    mocked.executeScheduledTaskMock.mockResolvedValue({
      taskId: "task-1",
      status: "error",
      startedAt: "2026-03-16T17:00:00.000Z",
      finishedAt: "2026-03-16T17:01:00.000Z",
      resultText: null,
      errorMessage: "Task failed",
    });

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-16T17:00:00.000Z"));

    await runtime.initialize({ api: {} } as Bot<Context>, await createDeliverySender());
    await vi.runAllTimersAsync();

    expect(mocked.tasks).toHaveLength(1);
    expect(mocked.tasks[0]?.lastStatus).toBe("error");
    expect(mocked.tasks[0]?.lastError).toBe("Task failed");
    expect(mocked.tasks[0]?.nextRunAt).toBe("2026-03-17T17:00:00.000Z");
    expect(mocked.sendBotTextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: 777,
        format: "raw",
        text: expect.stringContaining("Task failed"),
      }),
    );
    expect(mocked.sendBotTextMock).not.toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("Build · 🧠"),
      }),
    );

    runtime.__resetForTests();
    vi.useRealTimers();
  });

  it("sends the timeout error text returned by executor", async () => {
    ({ ScheduledTaskRuntime: ScheduledTaskRuntimeClass } =
      await import("../../../src/app/services/scheduled-task-runtime-service.js"));
    ({ foregroundSessionState } = await import("../../../src/app/managers/foreground-session-state-manager.js"));
    foregroundSessionState.__resetForTests();

    const runtime = new ScheduledTaskRuntimeClass();
    mocked.tasks = [createTask({ nextRunAt: "2026-03-16T09:59:00.000Z" })];
    mocked.executeScheduledTaskMock.mockResolvedValue({
      taskId: "task-1",
      status: "error",
      startedAt: "2026-03-16T10:00:00.000Z",
      finishedAt: "2026-03-16T10:01:00.000Z",
      resultText: null,
      errorMessage:
        "Request timed out after 300000ms. Check OpenCode model timeout settings: https://opencode.ai/docs/config/#models",
    });

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-16T10:00:00.000Z"));

    await runtime.initialize({ api: {} } as Bot<Context>, await createDeliverySender());
    await vi.runAllTimersAsync();

    expect(mocked.sendBotTextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: 777,
        format: "raw",
        text: expect.stringContaining("https://opencode.ai/docs/config/#models"),
      }),
    );

    runtime.__resetForTests();
    vi.useRealTimers();
  });

  it("does not start the same scheduled task twice while it is already running", async () => {
    ({ ScheduledTaskRuntime: ScheduledTaskRuntimeClass } =
      await import("../../../src/app/services/scheduled-task-runtime-service.js"));
    ({ foregroundSessionState } = await import("../../../src/app/managers/foreground-session-state-manager.js"));
    foregroundSessionState.__resetForTests();

    const runtime = new ScheduledTaskRuntimeClass();
    mocked.tasks = [createTask({ kind: "cron", nextRunAt: "2026-03-16T10:00:00.000Z" })];
    mocked.executeScheduledTaskMock.mockReturnValue(new Promise(() => undefined));

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-16T10:00:00.000Z"));

    await runtime.initialize({ api: {} } as Bot<Context>, await createDeliverySender());
    await Promise.resolve();

    (runtime as unknown as { startExecution(taskId: string): void }).startExecution("task-1");

    expect(mocked.executeScheduledTaskMock).toHaveBeenCalledTimes(1);

    runtime.__resetForTests();
    vi.useRealTimers();
  });

  it("stays silent when a task is removed mid-run", async () => {
    ({ ScheduledTaskRuntime: ScheduledTaskRuntimeClass } =
      await import("../../../src/app/services/scheduled-task-runtime-service.js"));
    ({ foregroundSessionState } = await import("../../../src/app/managers/foreground-session-state-manager.js"));
    foregroundSessionState.__resetForTests();

    const runtime = new ScheduledTaskRuntimeClass();
    mocked.tasks = [createTask({ kind: "cron", nextRunAt: "2026-03-16T10:00:00.000Z" })];
    let resolveExecution: (result: unknown) => void = () => undefined;
    mocked.executeScheduledTaskMock.mockReturnValue(
      new Promise((resolve) => {
        resolveExecution = resolve as (result: unknown) => void;
      }),
    );

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-16T10:00:00.000Z"));

    await runtime.initialize({ api: {} } as Bot<Context>, await createDeliverySender());
    await Promise.resolve();

    // Simulate user deletion while the run is in flight.
    mocked.tasks = [];
    runtime.removeTask("task-1");
    resolveExecution({
      taskId: "task-1",
      status: "success",
      startedAt: "2026-03-16T10:00:00.000Z",
      finishedAt: "2026-03-16T10:01:00.000Z",
      resultText: "Late result",
      errorMessage: null,
    });
    await Promise.resolve();
    await vi.runAllTimersAsync();

    expect(mocked.sendBotTextMock).not.toHaveBeenCalled();
    expect(mocked.executeScheduledTaskMock).toHaveBeenCalledTimes(1);

    runtime.__resetForTests();
    vi.useRealTimers();
  });

  it("does not reschedule or notify after shutdown", async () => {
    ({ ScheduledTaskRuntime: ScheduledTaskRuntimeClass } =
      await import("../../../src/app/services/scheduled-task-runtime-service.js"));
    ({ foregroundSessionState } = await import("../../../src/app/managers/foreground-session-state-manager.js"));
    foregroundSessionState.__resetForTests();

    const runtime = new ScheduledTaskRuntimeClass();
    mocked.tasks = [createTask({ kind: "cron", nextRunAt: "2026-03-16T10:00:00.000Z" })];
    let resolveExecution: (result: unknown) => void = () => undefined;
    mocked.executeScheduledTaskMock.mockReturnValue(
      new Promise((resolve) => {
        resolveExecution = resolve as (result: unknown) => void;
      }),
    );

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-16T10:00:00.000Z"));

    await runtime.initialize({ api: {} } as Bot<Context>, await createDeliverySender());
    await Promise.resolve();

    runtime.shutdown();
    resolveExecution({
      taskId: "task-1",
      status: "success",
      startedAt: "2026-03-16T10:00:00.000Z",
      finishedAt: "2026-03-16T10:01:00.000Z",
      resultText: "Late result",
      errorMessage: null,
    });
    await Promise.resolve();
    await vi.runAllTimersAsync();

    expect(mocked.sendBotTextMock).not.toHaveBeenCalled();
    expect(mocked.executeScheduledTaskMock).toHaveBeenCalledTimes(1);

    runtime.__resetForTests();
    vi.useRealTimers();
  });

  it("re-arms the timer when marking a task as running fails", async () => {
    ({ ScheduledTaskRuntime: ScheduledTaskRuntimeClass } =
      await import("../../../src/app/services/scheduled-task-runtime-service.js"));
    ({ foregroundSessionState } = await import("../../../src/app/managers/foreground-session-state-manager.js"));
    foregroundSessionState.__resetForTests();

    const runtime = new ScheduledTaskRuntimeClass();
    mocked.tasks = [createTask({ kind: "cron", nextRunAt: "2026-03-16T10:00:00.000Z" })];
    mocked.executeScheduledTaskMock.mockResolvedValue({
      taskId: "task-1",
      status: "success",
      startedAt: "2026-03-16T10:00:00.000Z",
      finishedAt: "2026-03-16T10:01:00.000Z",
      resultText: "All good",
      errorMessage: null,
    });

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-16T10:00:00.000Z"));

    await runtime.initialize({ api: {} } as Bot<Context>, await createDeliverySender());

    const { updateScheduledTask } = await import("../../../src/app/stores/scheduled-task-store.js");
    vi.mocked(updateScheduledTask).mockRejectedValueOnce(new Error("write failed"));

    await vi.runAllTimersAsync();

    // The failed run was dropped but the task was re-armed and ran again.
    expect(mocked.executeScheduledTaskMock).toHaveBeenCalledTimes(2);
    expect(mocked.tasks[0]?.lastStatus).not.toBe("running");

    runtime.__resetForTests();
    vi.useRealTimers();
  });

  it("keeps interrupted one-time tasks as errors without silently retrying", async () => {
    ({ ScheduledTaskRuntime: ScheduledTaskRuntimeClass } =
      await import("../../../src/app/services/scheduled-task-runtime-service.js"));
    ({ foregroundSessionState } = await import("../../../src/app/managers/foreground-session-state-manager.js"));
    foregroundSessionState.__resetForTests();

    const runtime = new ScheduledTaskRuntimeClass();
    mocked.tasks = [
      createTask({
        kind: "once",
        lastStatus: "running",
        nextRunAt: "2026-03-16T09:00:00.000Z",
      }),
    ];

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-16T10:00:00.000Z"));

    await runtime.initialize({ api: {} } as Bot<Context>, await createDeliverySender());
    await vi.runAllTimersAsync();

    expect(mocked.tasks).toHaveLength(1);
    expect(mocked.tasks[0]?.lastStatus).toBe("error");
    expect(mocked.tasks[0]?.lastError).toContain("Interrupted by bot restart");
    expect(mocked.tasks[0]?.nextRunAt).toBeNull();
    expect(mocked.executeScheduledTaskMock).not.toHaveBeenCalled();

    runtime.__resetForTests();
    vi.useRealTimers();
  });

  it("delivers past one failing recipient instead of head-of-line blocking", async () => {
    ({ ScheduledTaskRuntime: ScheduledTaskRuntimeClass } =
      await import("../../../src/app/services/scheduled-task-runtime-service.js"));
    ({ foregroundSessionState } = await import("../../../src/app/managers/foreground-session-state-manager.js"));
    foregroundSessionState.__resetForTests();

    const runtime = new ScheduledTaskRuntimeClass();
    mocked.tasks = [
      createTask({ id: "task-1", prompt: "First report", nextRunAt: "2026-03-16T10:00:00.000Z" }),
      createTask({ id: "task-2", prompt: "Second report", nextRunAt: "2026-03-16T10:00:00.000Z" }),
    ];
    mocked.executeScheduledTaskMock.mockImplementation(async (task: ScheduledTask) => ({
      taskId: task.id,
      status: "success",
      startedAt: "2026-03-16T10:00:00.000Z",
      finishedAt: "2026-03-16T10:01:00.000Z",
      resultText: `${task.prompt} done`,
      errorMessage: null,
    }));

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-16T10:00:00.000Z"));
    foregroundSessionState.markBusy("session-1", "D:\\Projects\\Repo");

    await runtime.initialize({ api: {} } as Bot<Context>, await createDeliverySender());
    await vi.runAllTimersAsync();

    // Both results are deferred while busy.
    expect(mocked.sendBotTextMock).not.toHaveBeenCalled();

    foregroundSessionState.markIdle("session-1");
    mocked.sendBotTextMock.mockRejectedValueOnce(new Error("send failed"));
    await runtime.flushDeferredDeliveries();

    // The second delivery went out despite the first one failing.
    expect(mocked.sendBotTextMock).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining("Second report") }),
    );

    mocked.sendBotTextMock.mockReset();
    mocked.sendBotTextMock.mockResolvedValue(undefined);
    await runtime.flushDeferredDeliveries();

    expect(mocked.sendBotTextMock).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining("First report") }),
    );

    runtime.__resetForTests();
    vi.useRealTimers();
  });
});
