import { beforeEach, describe, expect, it, vi } from "vitest";

const sessionCreateMock = vi.hoisted(() => vi.fn());

vi.mock("../../../src/opencode/client.js", () => ({
  opencodeClient: { session: { create: sessionCreateMock } },
}));

vi.mock("../../../src/utils/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  GUEST_SESSION_PERMISSIONS,
  SCHEDULED_TASK_SESSION_PERMISSIONS,
  USER_LANE_SESSION_PERMISSIONS,
  createSessionWithPermissions,
} from "../../../src/app/services/session-permissions.js";

describe("app/services/session-permissions", () => {
  beforeEach(() => {
    sessionCreateMock.mockReset();
  });

  it("pre-approves tools for scheduled tasks and denies questions", () => {
    expect(SCHEDULED_TASK_SESSION_PERMISSIONS).toContainEqual({
      permission: "bash",
      pattern: "*",
      action: "allow",
    });
    expect(SCHEDULED_TASK_SESSION_PERMISSIONS).toContainEqual({
      permission: "edit",
      pattern: "*",
      action: "allow",
    });
    expect(SCHEDULED_TASK_SESSION_PERMISSIONS).toContainEqual({
      permission: "question",
      pattern: "*",
      action: "deny",
    });
  });

  it("keeps guest questions askable for the numbered flow", () => {
    expect(GUEST_SESSION_PERMISSIONS).toContainEqual({
      permission: "bash",
      pattern: "*",
      action: "allow",
    });
    expect(
      GUEST_SESSION_PERMISSIONS.filter((rule) => rule.permission === "question"),
    ).toEqual([]);
  });

  it("denies questions in personal lanes without an answering UI", () => {
    expect(USER_LANE_SESSION_PERMISSIONS).toContainEqual({
      permission: "question",
      pattern: "*",
      action: "deny",
    });
  });

  it("creates the session with the given ruleset", async () => {
    sessionCreateMock.mockResolvedValue({
      data: { id: "s-1", directory: "D:/Repo" },
      error: null,
    });

    const result = await createSessionWithPermissions(
      "D:/Repo",
      "title",
      GUEST_SESSION_PERMISSIONS,
    );

    expect(result.data).toMatchObject({ id: "s-1" });
    expect(sessionCreateMock).toHaveBeenCalledTimes(1);
    expect(sessionCreateMock).toHaveBeenCalledWith({
      directory: "D:/Repo",
      title: "title",
      permission: GUEST_SESSION_PERMISSIONS,
    });
  });

  it("falls back to a plain session when the server rejects the ruleset", async () => {
    sessionCreateMock
      .mockResolvedValueOnce({ data: null, error: new Error("unknown field permission") })
      .mockResolvedValueOnce({ data: { id: "s-2", directory: "D:/Repo" }, error: null });

    const result = await createSessionWithPermissions(
      "D:/Repo",
      "title",
      GUEST_SESSION_PERMISSIONS,
    );

    expect(result.data).toMatchObject({ id: "s-2" });
    expect(sessionCreateMock).toHaveBeenCalledTimes(2);
    expect(sessionCreateMock.mock.calls[1]?.[0]).toEqual({
      directory: "D:/Repo",
      title: "title",
    });
  });
});
