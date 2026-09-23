import { beforeEach, describe, expect, it, vi } from "vitest";

const sessionDeleteMock = vi.hoisted(() => vi.fn(async () => ({ data: true, error: null })));

vi.mock("../../../src/opencode/client.js", () => ({
  opencodeClient: {
    session: {
      delete: sessionDeleteMock,
    },
  },
}));

vi.mock("../../../src/utils/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  __resetGuestChatSessionsForTests,
  getGuestChatSession,
  setGuestChatSession,
  touchGuestChatSession,
} from "../../../src/app/managers/guest-session-manager.js";

describe("app/managers/guest-session-manager", () => {
  beforeEach(() => {
    __resetGuestChatSessionsForTests();
    sessionDeleteMock.mockClear();
    vi.useRealTimers();
  });

  it("returns null when no session was recorded for the chat", () => {
    expect(getGuestChatSession(-100, "D:\\Repo")).toBeNull();
  });

  it("reuses the recorded session for the same chat and project", () => {
    setGuestChatSession(-100, {
      sessionId: "session-1",
      directory: "D:\\Repo",
      projectWorktree: "D:\\Repo",
    });

    expect(getGuestChatSession(-100, "D:\\Repo")).toMatchObject({ sessionId: "session-1" });
    expect(sessionDeleteMock).not.toHaveBeenCalled();
  });

  it("keeps chats isolated from each other", () => {
    setGuestChatSession(-100, {
      sessionId: "session-1",
      directory: "D:\\Repo",
      projectWorktree: "D:\\Repo",
    });

    expect(getGuestChatSession(-200, "D:\\Repo")).toBeNull();
    expect(sessionDeleteMock).not.toHaveBeenCalled();
  });

  it("evicts the mapping when the project changed", () => {
    setGuestChatSession(-100, {
      sessionId: "session-1",
      directory: "D:\\Old",
      projectWorktree: "D:\\Old",
    });

    expect(getGuestChatSession(-100, "D:\\Repo")).toBeNull();
    expect(sessionDeleteMock).toHaveBeenCalledWith({ sessionID: "session-1" });
  });

  it("evicts entries older than the TTL", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-16T10:00:00.000Z"));
    setGuestChatSession(-100, {
      sessionId: "session-1",
      directory: "D:\\Repo",
      projectWorktree: "D:\\Repo",
    });

    vi.setSystemTime(new Date("2026-03-17T11:00:00.000Z"));

    expect(getGuestChatSession(-100, "D:\\Repo")).toBeNull();
    expect(sessionDeleteMock).toHaveBeenCalledWith({ sessionID: "session-1" });
  });

  it("refreshes expiry on touch", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-16T10:00:00.000Z"));
    setGuestChatSession(-100, {
      sessionId: "session-1",
      directory: "D:\\Repo",
      projectWorktree: "D:\\Repo",
    });

    vi.setSystemTime(new Date("2026-03-17T09:00:00.000Z"));
    touchGuestChatSession(-100);
    vi.setSystemTime(new Date("2026-03-18T08:00:00.000Z"));

    expect(getGuestChatSession(-100, "D:\\Repo")).toMatchObject({ sessionId: "session-1" });
    expect(sessionDeleteMock).not.toHaveBeenCalled();
  });

  it("caps tracked chats and evicts the least recently recorded", () => {
    for (let index = 0; index < 21; index += 1) {
      setGuestChatSession(index, {
        sessionId: `session-${index}`,
        directory: "D:\\Repo",
        projectWorktree: "D:\\Repo",
      });
    }

    expect(getGuestChatSession(0, "D:\\Repo")).toBeNull();
    expect(getGuestChatSession(20, "D:\\Repo")).toMatchObject({ sessionId: "session-20" });
    expect(sessionDeleteMock).toHaveBeenCalledWith({ sessionID: "session-0" });
  });
});
