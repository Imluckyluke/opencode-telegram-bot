import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Context } from "grammy";
import { allowCommand } from "../../../src/bot/commands/allow-command.js";
import { t } from "../../../src/i18n/index.js";

const mocked = vi.hoisted(() => ({
  isAllowedTelegramUserMock: vi.fn(),
  getExtraAllowedUserIdsMock: vi.fn((): number[] => []),
  addExtraAllowedUserIdMock: vi.fn(),
  removeExtraAllowedUserIdMock: vi.fn(),
  getUserSessionMock: vi.fn(),
  clearUserSessionMock: vi.fn(),
  sessionDeleteMock: vi.fn(),
}));

vi.mock("../../../src/config.js", () => ({
  isAllowedTelegramUser: mocked.isAllowedTelegramUserMock,
  config: {
    telegram: { allowedUserIds: [] },
    opencode: { apiUrl: "http://localhost:4096", username: "opencode", password: "" },
  },
  buildTelegramConfig: vi.fn(),
  parseInitialSettingsPreset: vi.fn(() => ({})),
  DEFAULT_AGENT_CONTEXT_NOTE: "",
}));

vi.mock("../../../src/app/stores/settings-store.js", () => ({
  getExtraAllowedUserIds: mocked.getExtraAllowedUserIdsMock,
  addExtraAllowedUserId: mocked.addExtraAllowedUserIdMock,
  removeExtraAllowedUserId: mocked.removeExtraAllowedUserIdMock,
  getUserSession: mocked.getUserSessionMock,
  clearUserSession: mocked.clearUserSessionMock,
}));

vi.mock("../../../src/opencode/client.js", () => ({
  opencodeClient: { session: { delete: mocked.sessionDeleteMock } },
}));

function createContext(text: string, replyFrom?: { id: number }): Context {
  return {
    from: { id: 111 },
    message: {
      text,
      ...(replyFrom
        ? { reply_to_message: { from: replyFrom } }
        : {}),
    },
    reply: vi.fn().mockResolvedValue(undefined),
  } as unknown as Context;
}

describe("bot/commands/allow-command", () => {
  beforeEach(() => {
    // Owner is caller 111; grant targets (222/333) are not env-listed owners.
    mocked.isAllowedTelegramUserMock.mockReset().mockImplementation((id: number) => id === 111);
    mocked.getExtraAllowedUserIdsMock.mockReset().mockReturnValue([]);
    mocked.addExtraAllowedUserIdMock.mockReset().mockReturnValue(true);
    mocked.removeExtraAllowedUserIdMock.mockReset().mockReturnValue(true);
    mocked.getUserSessionMock.mockReset().mockReturnValue(undefined);
    mocked.clearUserSessionMock.mockReset();
    mocked.sessionDeleteMock.mockReset().mockResolvedValue({ data: true, error: null });
  });

  it("refuses non-owners", async () => {
    mocked.isAllowedTelegramUserMock.mockReturnValue(false);
    const ctx = createContext("/allow 222");

    await allowCommand(ctx as never);

    expect(ctx.reply).toHaveBeenCalledWith(t("tier.blocked"));
    expect(mocked.addExtraAllowedUserIdMock).not.toHaveBeenCalled();
  });

  it("lists users and usage with no args", async () => {
    mocked.getExtraAllowedUserIdsMock.mockReturnValue([222]);
    const ctx = createContext("/allow");

    await allowCommand(ctx as never);

    expect(ctx.reply).toHaveBeenCalledWith(
      t("allow.list", { users: "`222`" }),
      { parse_mode: "Markdown" },
    );
  });

  it("grants an id argument", async () => {
    const ctx = createContext("/allow 222");

    await allowCommand(ctx as never);

    expect(mocked.addExtraAllowedUserIdMock).toHaveBeenCalledWith(222);
    expect(ctx.reply).toHaveBeenCalledWith(
      t("allow.granted", { user: "`222`" }),
      { parse_mode: "Markdown" },
    );
  });

  it("grants the replied author with no args", async () => {
    const ctx = createContext("/allow", { id: 333 });

    await allowCommand(ctx as never);

    expect(mocked.addExtraAllowedUserIdMock).toHaveBeenCalledWith(333);
  });

  it("revokes with remove", async () => {
    const ctx = createContext("/allow remove 222");

    await allowCommand(ctx as never);

    expect(mocked.removeExtraAllowedUserIdMock).toHaveBeenCalledWith(222);
    expect(ctx.reply).toHaveBeenCalledWith(
      t("allow.revoked", { user: "`222`" }),
      { parse_mode: "Markdown" },
    );
  });

  it("deletes the revoked user's lane session and clears the mapping", async () => {
    mocked.getUserSessionMock.mockReturnValue({
      id: "lane-1",
      title: "Chat X",
      directory: "D:/Repo",
    });
    const ctx = createContext("/allow remove 222");

    await allowCommand(ctx as never);

    expect(mocked.sessionDeleteMock).toHaveBeenCalledWith({
      sessionID: "lane-1",
      directory: "D:/Repo",
    });
    expect(mocked.clearUserSessionMock).toHaveBeenCalledWith(222);
    expect(ctx.reply).toHaveBeenCalledWith(
      t("allow.revoked", { user: "`222`" }),
      { parse_mode: "Markdown" },
    );
  });

  it("still revokes when the user has no lane session", async () => {
    const ctx = createContext("/allow remove 222");

    await allowCommand(ctx as never);

    expect(mocked.sessionDeleteMock).not.toHaveBeenCalled();
    expect(mocked.clearUserSessionMock).toHaveBeenCalledWith(222);
    expect(ctx.reply).toHaveBeenCalledWith(
      t("allow.revoked", { user: "`222`" }),
      { parse_mode: "Markdown" },
    );
  });

  it("rejects invalid ids", async () => {
    const ctx = createContext("/allow abc");

    await allowCommand(ctx as never);

    expect(ctx.reply).toHaveBeenCalledWith(t("allow.invalid"));
  });

  it.each(["123abc", "0", "00", "-5", "42 extra"])(
    "rejects malformed grant id %j",
    async (badId) => {
      const ctx = createContext(`/allow ${badId}`.trimEnd());

      await allowCommand(ctx as never);

      expect(ctx.reply).toHaveBeenCalledWith(t("allow.invalid"));
      expect(mocked.addExtraAllowedUserIdMock).not.toHaveBeenCalled();
    },
  );

  it.each(["123abc", "0", "42 extra"])("rejects malformed revoke id %j", async (badId) => {
    const ctx = createContext(`/allow remove ${badId}`);

    await allowCommand(ctx as never);

    expect(ctx.reply).toHaveBeenCalledWith(t("allow.invalid"));
    expect(mocked.removeExtraAllowedUserIdMock).not.toHaveBeenCalled();
  });

  it("accepts an id padded with spaces", async () => {
    const ctx = createContext("/allow   42  ");

    await allowCommand(ctx as never);

    expect(mocked.addExtraAllowedUserIdMock).toHaveBeenCalledWith(42);
  });
});
