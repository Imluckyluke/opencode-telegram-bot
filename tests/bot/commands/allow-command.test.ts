import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Context } from "grammy";
import { allowCommand } from "../../../src/bot/commands/allow-command.js";
import { t } from "../../../src/i18n/index.js";

const mocked = vi.hoisted(() => ({
  isAllowedTelegramUserMock: vi.fn(),
  getExtraAllowedUserIdsMock: vi.fn((): number[] => []),
  addExtraAllowedUserIdMock: vi.fn(),
  removeExtraAllowedUserIdMock: vi.fn(),
}));

vi.mock("../../../src/config.js", () => ({
  isAllowedTelegramUser: mocked.isAllowedTelegramUserMock,
}));

vi.mock("../../../src/app/stores/settings-store.js", () => ({
  getExtraAllowedUserIds: mocked.getExtraAllowedUserIdsMock,
  addExtraAllowedUserId: mocked.addExtraAllowedUserIdMock,
  removeExtraAllowedUserId: mocked.removeExtraAllowedUserIdMock,
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
    mocked.isAllowedTelegramUserMock.mockReset().mockReturnValue(true);
    mocked.getExtraAllowedUserIdsMock.mockReset().mockReturnValue([]);
    mocked.addExtraAllowedUserIdMock.mockReset().mockReturnValue(true);
    mocked.removeExtraAllowedUserIdMock.mockReset().mockReturnValue(true);
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

  it("rejects invalid ids", async () => {
    const ctx = createContext("/allow abc");

    await allowCommand(ctx as never);

    expect(ctx.reply).toHaveBeenCalledWith(t("allow.invalid"));
  });
});
