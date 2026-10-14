import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Context } from "grammy";

const mocked = vi.hoisted(() => ({
  loggerDebugMock: vi.fn(),
  loggerWarnMock: vi.fn(),
}));

vi.mock("../../../src/utils/logger.js", () => ({
  logger: {
    debug: mocked.loggerDebugMock,
    info: vi.fn(),
    warn: mocked.loggerWarnMock,
    error: vi.fn(),
  },
}));

vi.mock("../../../src/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/config.js")>();
  return {
    config: {
      ...actual.config,
      telegram: { ...actual.config.telegram, allowedUserId: 777 },
    },
  };
});

// Fork's isAllowedUser lives in settings-store (tiers/allowlist), not config.
vi.mock("../../../src/app/stores/settings-store.js", () => ({
  isAllowedUser: (id: number | undefined) => id === 777,
}));

import { authMiddleware } from "../../../src/bot/middleware/auth.js";

const ALLOWED_USER_ID = 777;
const BOT_ID = 555;

function createContext(
  from: { id: number; is_bot: boolean },
  chatId: number,
): { ctx: Context; setMyCommands: ReturnType<typeof vi.fn> } {
  const setMyCommands = vi.fn().mockResolvedValue(true);
  const ctx = {
    from,
    chat: { id: chatId },
    me: { id: BOT_ID, is_bot: true },
    message: { message_id: 1 },
    api: { setMyCommands },
  } as unknown as Context;
  return { ctx, setMyCommands };
}

describe("bot/middleware/auth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("passes updates from the allowed user to the next middleware", async () => {
    const { ctx } = createContext({ id: ALLOWED_USER_ID, is_bot: false }, ALLOWED_USER_ID);
    const next = vi.fn().mockResolvedValue(undefined);

    await authMiddleware(ctx, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(mocked.loggerWarnMock).not.toHaveBeenCalled();
  });

  it("drops updates authored by the bot itself without a warning", async () => {
    const { ctx, setMyCommands } = createContext({ id: BOT_ID, is_bot: true }, ALLOWED_USER_ID);
    const next = vi.fn();

    await authMiddleware(ctx, next);

    expect(next).not.toHaveBeenCalled();
    expect(mocked.loggerWarnMock).not.toHaveBeenCalled();
    expect(mocked.loggerDebugMock).toHaveBeenCalledWith(
      expect.stringContaining("Ignoring update from the bot itself"),
    );
    expect(setMyCommands).not.toHaveBeenCalled();
  });

  it("warns about a foreign user and empties the foreign chat's commands", async () => {
    const { ctx, setMyCommands } = createContext({ id: 999, is_bot: false }, 999);
    const next = vi.fn();

    await authMiddleware(ctx, next);

    expect(next).not.toHaveBeenCalled();
    expect(mocked.loggerWarnMock).toHaveBeenCalledWith(
      "Unauthorized access attempt from user ID: 999",
    );
    expect(setMyCommands).toHaveBeenCalledWith([], { scope: { type: "chat", chat_id: 999 } });
  });

  it("still warns about another bot", async () => {
    const { ctx } = createContext({ id: 888, is_bot: true }, 888);
    const next = vi.fn();

    await authMiddleware(ctx, next);

    expect(next).not.toHaveBeenCalled();
    expect(mocked.loggerWarnMock).toHaveBeenCalledWith(
      "Unauthorized access attempt from user ID: 888",
    );
  });

  it("warns about a foreign user in the allowed user's chat without resetting commands", async () => {
    const { ctx, setMyCommands } = createContext({ id: 999, is_bot: false }, ALLOWED_USER_ID);
    const next = vi.fn();

    await authMiddleware(ctx, next);

    expect(next).not.toHaveBeenCalled();
    expect(mocked.loggerWarnMock).toHaveBeenCalledWith(
      "Unauthorized access attempt from user ID: 999",
    );
    expect(setMyCommands).not.toHaveBeenCalled();
  });
});
