import { beforeEach, describe, expect, it, vi } from "vitest";

const settingsSession = vi.hoisted(() => ({ current: null as { id: string } | null }));
const sessionGet = vi.hoisted(() => vi.fn());

vi.mock("../../../src/opencode/client.js", () => ({
  opencodeClient: { session: { get: sessionGet } },
}));

vi.mock("../../../src/app/stores/settings-store.js", () => ({
  getCurrentSession: vi.fn(() => settingsSession.current),
  setCurrentSession: vi.fn((session: { id: string }) => {
    settingsSession.current = session;
  }),
  clearSession: vi.fn(() => {
    settingsSession.current = null;
  }),
}));

import { promptQueue } from "../../../src/app/managers/prompt-queue-manager.js";
import { promptAttachment } from "../../../src/app/managers/prompt-attachment-manager.js";
import {
  clearSession,
  fetchSessionTitle,
  setCurrentSession,
} from "../../../src/app/services/session-service.js";
import { createIncomingPrompt } from "../../../src/app/types/prompt.js";

const SESSION = { id: "session-1", title: "Session 1", directory: "D:\\Projects\\Repo" };

describe("app/services/session-service", () => {
  beforeEach(() => {
    settingsSession.current = null;
    promptQueue.__resetForTests();
    promptAttachment.__resetForTests();
  });

  it("drops queued prompts when switching to another session", () => {
    setCurrentSession(SESSION);
    promptQueue.add(createIncomingPrompt("queued for session 1"));

    setCurrentSession({ ...SESSION, id: "session-2" });

    expect(promptQueue.size()).toBe(0);
  });

  it("keeps queued prompts when the same session is only renamed", () => {
    setCurrentSession(SESSION);
    promptQueue.add(createIncomingPrompt("queued for session 1"));

    setCurrentSession({ ...SESSION, title: "Renamed" });

    expect(promptQueue.size()).toBe(1);
  });

  it("drops queued prompts when the session is cleared", () => {
    setCurrentSession(SESSION);
    promptQueue.add(createIncomingPrompt("queued for session 1"));

    clearSession();

    expect(promptQueue.size()).toBe(0);
  });

  it("drops the pending attachment when switching to another session", () => {
    setCurrentSession(SESSION);
    promptAttachment.set("D:\\Projects\\Repo\\src\\index.ts", "D:\\Projects\\Repo");

    setCurrentSession({ ...SESSION, id: "session-2" });

    expect(promptAttachment.get()).toBeNull();
  });

  it("keeps the pending attachment when the same session is only renamed", () => {
    setCurrentSession(SESSION);
    promptAttachment.set("D:\\Projects\\Repo\\src\\index.ts", "D:\\Projects\\Repo");

    setCurrentSession({ ...SESSION, title: "Renamed" });

    expect(promptAttachment.get()).not.toBeNull();
  });

  it("drops the pending attachment when the session is cleared", () => {
    setCurrentSession(SESSION);
    promptAttachment.set("D:\\Projects\\Repo\\src\\index.ts", "D:\\Projects\\Repo");

    clearSession();

    expect(promptAttachment.get()).toBeNull();
  });
});

describe("app/services/session-service fetchSessionTitle", () => {
  beforeEach(() => {
    sessionGet.mockReset();
  });

  it("returns the title OpenCode has for the session now", async () => {
    sessionGet.mockResolvedValue({
      data: { id: "session-1", title: "Generated" },
      error: undefined,
    });

    await expect(fetchSessionTitle({ ...SESSION, title: "" })).resolves.toBe("Generated");
    expect(sessionGet).toHaveBeenCalledWith({
      sessionID: "session-1",
      directory: SESSION.directory,
    });
  });

  it("keeps an empty title OpenCode reports for an unnamed session", async () => {
    sessionGet.mockResolvedValue({ data: { id: "session-1", title: "" }, error: undefined });

    await expect(fetchSessionTitle(SESSION)).resolves.toBe("");
  });

  it("falls back to the remembered title when OpenCode answers with an error", async () => {
    sessionGet.mockResolvedValue({ data: undefined, error: new Error("not found") });

    await expect(fetchSessionTitle(SESSION)).resolves.toBe("Session 1");
  });

  it("falls back to the remembered title when OpenCode answers without a session", async () => {
    sessionGet.mockResolvedValue({ data: undefined, error: undefined });

    await expect(fetchSessionTitle(SESSION)).resolves.toBe("Session 1");
  });

  it("falls back to the remembered title when the call throws", async () => {
    sessionGet.mockRejectedValue(new TypeError("fetch failed"));

    await expect(fetchSessionTitle(SESSION)).resolves.toBe("Session 1");
  });
});
