import { beforeEach, describe, expect, it, vi } from "vitest";

const sessionCreateMock = vi.hoisted(() => vi.fn());

vi.mock("../../../src/opencode/client.js", () => ({
  opencodeClient: { session: { create: sessionCreateMock } },
}));

vi.mock("../../../src/utils/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  SCHEDULED_TASK_SESSION_PERMISSIONS,
  createUnattendedSession,
} from "../../../src/app/services/scheduled-task-session-service.js";

describe("app/services/scheduled-task-session-service", () => {
  beforeEach(() => {
    sessionCreateMock.mockReset();
  });

  it("creates the session with pre-approved tool permissions", async () => {
    sessionCreateMock.mockResolvedValue({
      data: { id: "s-1", directory: "D:/Repo" },
      error: null,
    });

    const result = await createUnattendedSession("D:/Repo", "Scheduled task run");

    expect(result.data).toMatchObject({ id: "s-1" });
    expect(sessionCreateMock).toHaveBeenCalledTimes(1);
    expect(sessionCreateMock).toHaveBeenCalledWith({
      directory: "D:/Repo",
      title: "Scheduled task run",
      permission: SCHEDULED_TASK_SESSION_PERMISSIONS,
    });
    expect(SCHEDULED_TASK_SESSION_PERMISSIONS).toContainEqual({
      permission: "question",
      pattern: "*",
      action: "deny",
    });
  });

  it("falls back to a plain session when the server rejects the ruleset", async () => {
    sessionCreateMock
      .mockResolvedValueOnce({ data: null, error: new Error("unknown field permission") })
      .mockResolvedValueOnce({
        data: { id: "s-2", directory: "D:/Repo" },
        error: null,
      });

    const result = await createUnattendedSession("D:/Repo", "Scheduled task run");

    expect(result.data).toMatchObject({ id: "s-2" });
    expect(sessionCreateMock).toHaveBeenCalledTimes(2);
    expect(sessionCreateMock.mock.calls[1]?.[0]).toEqual({
      directory: "D:/Repo",
      title: "Scheduled task run",
    });
  });
});
