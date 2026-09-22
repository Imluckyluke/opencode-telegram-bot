import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setRuntimeMode } from "../../../src/runtime/mode.js";
import { __resetSettingsForTests, loadSettings } from "../../../src/app/stores/settings-store.js";
import {
  addScheduledTask,
  listScheduledTasks,
  removeScheduledTask,
  tryAddScheduledTask,
} from "../../../src/app/stores/scheduled-task-store.js";
import {
  cleanupScheduledTaskSessionIgnores,
  isScheduledTaskSessionIgnored,
  registerScheduledTaskSessionIgnore,
  removeScheduledTaskSessionIgnore,
} from "../../../src/app/services/scheduled-task-session-ignore-service.js";
import type { ScheduledTask } from "../../../src/app/types/scheduled-task.js";

const { sessionDeleteMock } = vi.hoisted(() => ({
  sessionDeleteMock: vi.fn(async () => ({ data: true, error: null })),
}));

vi.mock("../../../src/opencode/client.js", () => ({
  opencodeClient: {
    session: {
      delete: sessionDeleteMock,
    },
  },
}));

function createScheduledTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: "task-1",
    kind: "cron",
    projectId: "project-1",
    projectWorktree: "D:/Projects/Repo",
    agent: "build",
    model: {
      providerID: "openai",
      modelID: "gpt-5",
      variant: "default",
    },
    scheduleText: "every 5 minutes",
    scheduleSummary: "Every 5 minutes",
    timezone: "UTC",
    cron: "*/5 * * * *",
    prompt: "Check repository status",
    createdAt: "2026-03-15T10:00:00.000Z",
    nextRunAt: "2026-03-15T10:05:00.000Z",
    lastRunAt: null,
    runCount: 0,
    lastStatus: "idle",
    lastError: null,
    ...overrides,
  } as ScheduledTask;
}

describe("app/stores/scheduled-task-store", () => {
  let tempHome: string;

  beforeEach(async () => {
    tempHome = await mkdtemp(path.join(os.tmpdir(), "opencode-telegram-task-store-"));
    process.env.OPENCODE_TELEGRAM_HOME = tempHome;
    setRuntimeMode("installed");
    __resetSettingsForTests();
    await loadSettings();
  });

  afterEach(async () => {
    delete process.env.OPENCODE_TELEGRAM_HOME;
    __resetSettingsForTests();
    await rm(tempHome, { recursive: true, force: true });
  });

  it("persists scheduled tasks to settings.json", async () => {
    const task = createScheduledTask();

    await addScheduledTask(task);

    expect(listScheduledTasks()).toEqual([task]);

    const settingsPath = path.join(tempHome, "settings.json");
    const settingsFile = JSON.parse(await readFile(settingsPath, "utf-8")) as {
      scheduledTasks?: ScheduledTask[];
    };

    expect(settingsFile.scheduledTasks).toEqual([task]);
  });

  it("backfills the agent for legacy tasks persisted without it", async () => {
    const legacyTask = createScheduledTask();
    Reflect.deleteProperty(legacyTask, "agent");

    await addScheduledTask(legacyTask);

    expect(listScheduledTasks()[0]).toMatchObject({
      id: "task-1",
      agent: "build",
    });
  });

  it("removes scheduled task from persisted storage", async () => {
    const firstTask = createScheduledTask();
    const secondTask = createScheduledTask({
      id: "task-2",
      kind: "once",
      scheduleText: "tomorrow at 12:00",
      scheduleSummary: "Tomorrow at 12:00",
      runAt: "2026-03-16T12:00:00.000Z",
      cron: undefined,
      nextRunAt: "2026-03-16T12:00:00.000Z",
    });

    await addScheduledTask(firstTask);
    await addScheduledTask(secondTask);

    await removeScheduledTask("task-1");

    expect(listScheduledTasks()).toEqual([secondTask]);
  });

  it("persists scheduled task session ignores and prunes stale entries", async () => {
    await registerScheduledTaskSessionIgnore("fresh-session", new Date("2026-03-16T10:00:00.000Z"));
    await registerScheduledTaskSessionIgnore("stale-session", new Date("2026-03-15T09:59:59.000Z"));

    expect(isScheduledTaskSessionIgnored("fresh-session", new Date("2026-03-16T12:00:00.000Z"))).toBe(
      true,
    );
    expect(isScheduledTaskSessionIgnored("stale-session", new Date("2026-03-16T12:00:00.000Z"))).toBe(
      false,
    );

    const removed = await cleanupScheduledTaskSessionIgnores(new Date("2026-03-16T12:00:00.000Z"));

    expect(removed).toBe(1);
    // Expired temporary sessions are deleted so kept-for-inspection runs cannot leak.
    expect(sessionDeleteMock).toHaveBeenCalledWith({ sessionID: "stale-session" });

    const settingsPath = path.join(tempHome, "settings.json");
    const settingsFile = JSON.parse(await readFile(settingsPath, "utf-8")) as {
      scheduledTaskSessionIgnores?: Array<{ sessionId: string; createdAt: string }>;
    };
    expect(settingsFile.scheduledTaskSessionIgnores).toEqual([
      { sessionId: "fresh-session", createdAt: "2026-03-16T10:00:00.000Z" },
    ]);

    await removeScheduledTaskSessionIgnore("fresh-session");

    expect(isScheduledTaskSessionIgnored("fresh-session", new Date("2026-03-16T12:00:00.000Z"))).toBe(
      false,
    );
  });

  it("adds atomically only while schedulable tasks stay under the limit", async () => {
    const activeTask = createScheduledTask({ id: "task-1" });
    const deadTask = createScheduledTask({ id: "task-0", nextRunAt: null });

    await expect(tryAddScheduledTask(activeTask, 1)).resolves.toBe(true);
    await expect(tryAddScheduledTask(createScheduledTask({ id: "task-2" }), 1)).resolves.toBe(
      false,
    );
    expect(listScheduledTasks().map((task) => task.id)).toEqual(["task-1"]);

    // Terminal rows do not consume quota.
    await expect(tryAddScheduledTask(deadTask, 1)).resolves.toBe(true);
    expect(listScheduledTasks().map((task) => task.id)).toEqual(["task-1", "task-0"]);
  });
});
