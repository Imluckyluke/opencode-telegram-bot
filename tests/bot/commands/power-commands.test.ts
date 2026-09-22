import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Context } from "grammy";
import { disableCommand, enableCommand } from "../../../src/bot/commands/power-command.js";
import { deleteSessionsCommand } from "../../../src/bot/commands/delete-sessions-command.js";
import { restartCommand } from "../../../src/bot/commands/restart-command.js";
import { t } from "../../../src/i18n/index.js";

const mocked = vi.hoisted(() => ({
  isAllowedTelegramUserMock: vi.fn(),
  isBotDisabledMock: vi.fn(() => false),
  setBotDisabledMock: vi.fn(),
  getProjectsMock: vi.fn((): unknown[] => []),
  sessionListMock: vi.fn(),
  sessionDeleteMock: vi.fn(),
  clearSessionMock: vi.fn(),
  clearSessionDirectoryCacheMock: vi.fn(),
  clearAllUserSessionsMock: vi.fn(() => 0),
  cleanupIgnoresMock: vi.fn(),
  pinnedClearMock: vi.fn(),
}));

vi.mock("../../../src/config.js", () => ({
  isAllowedTelegramUser: mocked.isAllowedTelegramUserMock,
}));

vi.mock("../../../src/app/stores/settings-store.js", () => ({
  isBotDisabled: mocked.isBotDisabledMock,
  setBotDisabled: mocked.setBotDisabledMock,
  clearSession: mocked.clearSessionMock,
  clearSessionDirectoryCache: mocked.clearSessionDirectoryCacheMock,
  clearAllUserSessions: mocked.clearAllUserSessionsMock,
}));

vi.mock("../../../src/app/services/project-service.js", () => ({
  getProjects: mocked.getProjectsMock,
}));

vi.mock("../../../src/opencode/client.js", () => ({
  opencodeClient: {
    session: {
      list: mocked.sessionListMock,
      delete: mocked.sessionDeleteMock,
    },
  },
}));

vi.mock("../../../src/app/services/scheduled-task-session-ignore-service.js", () => ({
  cleanupScheduledTaskSessionIgnores: mocked.cleanupIgnoresMock,
}));

vi.mock("../../../src/bot/pinned/pinned-message-manager.js", () => ({
  pinnedMessageManager: { clear: mocked.pinnedClearMock },
}));

function createContext(): Context {
  return {
    from: { id: 111 },
    chat: { id: 111 },
    reply: vi.fn().mockResolvedValue({ message_id: 7 }),
    api: { editMessageText: vi.fn().mockResolvedValue(undefined) },
  } as unknown as Context;
}

describe("bot/commands/power-command", () => {
  beforeEach(() => {
    mocked.isAllowedTelegramUserMock.mockReset().mockReturnValue(true);
    mocked.setBotDisabledMock.mockReset();
  });

  it("refuses non-owners", async () => {
    mocked.isAllowedTelegramUserMock.mockReturnValue(false);
    const ctx = createContext();

    await disableCommand(ctx as never);
    await enableCommand(ctx as never);

    expect(ctx.reply).toHaveBeenCalledWith(t("tier.blocked"));
    expect(mocked.setBotDisabledMock).not.toHaveBeenCalled();
  });

  it("disables and enables", async () => {
    const disableCtx = createContext();
    await disableCommand(disableCtx as never);
    expect(mocked.setBotDisabledMock).toHaveBeenCalledWith(true);
    expect(disableCtx.reply).toHaveBeenCalledWith(t("bot.disabled_on"));

    mocked.isBotDisabledMock.mockReturnValue(true);
    const enableCtx = createContext();
    await enableCommand(enableCtx as never);
    expect(mocked.setBotDisabledMock).toHaveBeenCalledWith(false);
    expect(enableCtx.reply).toHaveBeenCalledWith(t("bot.enabled"));
  });
});

describe("bot/commands/delete-sessions-command", () => {
  beforeEach(() => {
    mocked.isAllowedTelegramUserMock.mockReset().mockReturnValue(true);
    mocked.getProjectsMock.mockReset().mockResolvedValue([{ worktree: "/repo" }]);
    mocked.sessionListMock.mockReset().mockResolvedValue({
      data: [{ id: "s1" }, { id: "s2" }],
      error: null,
    });
    mocked.sessionDeleteMock.mockReset().mockResolvedValue({ data: {}, error: null });
    mocked.cleanupIgnoresMock.mockReset().mockResolvedValue(0);
    mocked.pinnedClearMock.mockReset().mockResolvedValue(undefined);
    mocked.clearSessionMock.mockReset();
    mocked.clearSessionDirectoryCacheMock.mockReset();
    mocked.clearAllUserSessionsMock.mockReset().mockReturnValue(0);
  });

  it("refuses non-owners", async () => {
    mocked.isAllowedTelegramUserMock.mockReturnValue(false);
    const ctx = createContext();

    await deleteSessionsCommand(ctx as never);

    expect(ctx.reply).toHaveBeenCalledWith(t("tier.blocked"));
    expect(mocked.sessionDeleteMock).not.toHaveBeenCalled();
  });

  it("deletes every session and clears bot state", async () => {
    const ctx = createContext();

    await deleteSessionsCommand(ctx as never);

    expect(mocked.sessionDeleteMock).toHaveBeenCalledTimes(2);
    expect(mocked.clearSessionMock).toHaveBeenCalledTimes(1);
    expect(mocked.clearAllUserSessionsMock).toHaveBeenCalledTimes(1);
    expect(ctx.api.editMessageText).toHaveBeenCalledWith(
      111,
      expect.any(Number),
      t("deletesessions.done", { deleted: 2, failed: 0 }),
    );
  });

  it("falls back to a fresh message when the status notice fails to send", async () => {
    const ctx = createContext();
    (ctx.reply as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(undefined);

    await deleteSessionsCommand(ctx as never);

    expect(mocked.sessionDeleteMock).toHaveBeenCalledTimes(2);
    expect(ctx.api.editMessageText).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledWith(
      t("deletesessions.done", { deleted: 2, failed: 0 }),
    );
  });
});

describe("bot/commands/restart-command", () => {
  beforeEach(() => {
    mocked.isAllowedTelegramUserMock.mockReset().mockReturnValue(true);
  });

  it("refuses non-owners", async () => {
    mocked.isAllowedTelegramUserMock.mockReturnValue(false);
    const ctx = createContext();

    await restartCommand(ctx as never);

    expect(ctx.reply).toHaveBeenCalledWith(t("tier.blocked"));
  });
});
