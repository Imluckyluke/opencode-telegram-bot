import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Context } from "grammy";
import { tierGuardMiddleware } from "../../../src/bot/middleware/tier-guard.js";
import { t } from "../../../src/i18n/index.js";

const mocked = vi.hoisted(() => ({
  isAllowedTelegramUserMock: vi.fn(),
  isAllowedUserMock: vi.fn(),
  isBotDisabledMock: vi.fn(() => false),
  isUserLaneContentMock: vi.fn(() => false),
  processUserLaneMessageMock: vi.fn(),
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
  isAllowedUser: mocked.isAllowedUserMock,
  isBotDisabled: mocked.isBotDisabledMock,
}));

vi.mock("../../../src/bot/handlers/user-lane.js", () => ({
  isUserLaneContent: mocked.isUserLaneContentMock,
  processUserLaneMessage: mocked.processUserLaneMessageMock,
}));

function messageContext(text: string): Context {
  return {
    from: { id: 999 },
    chat: { id: 999 },
    message: { text },
    reply: vi.fn().mockResolvedValue(undefined),
  } as unknown as Context;
}

function callbackContext(data: string): Context {
  return {
    from: { id: 999 },
    chat: { id: 999 },
    callbackQuery: { data },
    answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
  } as unknown as Context;
}

describe("bot/middleware/tier-guard", () => {
  beforeEach(() => {
    mocked.isAllowedTelegramUserMock.mockReset().mockReturnValue(false);
    mocked.isAllowedUserMock.mockReset().mockReturnValue(false);
    mocked.isBotDisabledMock.mockReset().mockReturnValue(false);
    mocked.isUserLaneContentMock.mockReset().mockReturnValue(false);
    mocked.processUserLaneMessageMock.mockReset();
  });

  it("lets owners through without checks", async () => {
    mocked.isAllowedTelegramUserMock.mockReturnValue(true);
    const next = vi.fn();
    const ctx = messageContext("/settings");

    await tierGuardMiddleware(ctx, next);

    expect(next).toHaveBeenCalledOnce();
    expect(ctx.reply).not.toHaveBeenCalled();
  });

  it("routes granted content messages into the user lane", async () => {
    mocked.isAllowedUserMock.mockReturnValue(true);
    mocked.isUserLaneContentMock.mockReturnValue(true);
    const next = vi.fn();
    const ctx = messageContext("do the thing");

    await tierGuardMiddleware(ctx, next);

    expect(next).not.toHaveBeenCalled();
    expect(mocked.processUserLaneMessageMock).toHaveBeenCalledWith(ctx);
  });

  it("denies commands for granted users", async () => {
    mocked.isAllowedUserMock.mockReturnValue(true);
    const next = vi.fn();
    const ctx = messageContext("/sessions");

    await tierGuardMiddleware(ctx, next);

    expect(next).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledWith(t("tier.blocked"));
  });

  it("denies callbacks for granted users", async () => {
    mocked.isAllowedUserMock.mockReturnValue(true);
    const next = vi.fn();
    const ctx = callbackContext("session:abc");

    await tierGuardMiddleware(ctx, next);

    expect(next).not.toHaveBeenCalled();
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({
      text: t("tier.blocked"),
      show_alert: true,
    });
  });

  it("blocks everything but /enable when disabled", async () => {
    mocked.isAllowedTelegramUserMock.mockReturnValue(true);
    mocked.isBotDisabledMock.mockReturnValue(true);
    const next = vi.fn();
    const ctx = messageContext("/status");

    await tierGuardMiddleware(ctx, next);

    expect(next).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledWith(t("bot.disabled"));
  });

  it("lets owner /enable through when disabled", async () => {
    mocked.isAllowedTelegramUserMock.mockReturnValue(true);
    mocked.isBotDisabledMock.mockReturnValue(true);
    const next = vi.fn();
    const ctx = messageContext("/enable");

    await tierGuardMiddleware(ctx, next);

    expect(next).toHaveBeenCalledOnce();
  });

  function guestContext(callerId: number): Context {
    return {
      from: { id: callerId },
      update: {
        guest_message: { guest_bot_caller_user: { id: callerId } },
      },
    } as unknown as Context;
  }

  it("lets owners summon in guest mode", async () => {
    mocked.isAllowedTelegramUserMock.mockReturnValue(true);
    const next = vi.fn();

    await tierGuardMiddleware(guestContext(111), next);

    expect(next).toHaveBeenCalledOnce();
  });

  it("lets granted users summon in guest mode without touching shared state", async () => {
    mocked.isAllowedUserMock.mockReturnValue(true);
    const next = vi.fn();

    await tierGuardMiddleware(guestContext(999), next);

    expect(next).toHaveBeenCalledOnce();
    expect(mocked.processUserLaneMessageMock).not.toHaveBeenCalled();
  });

  it("silently drops guest summons from strangers", async () => {
    const next = vi.fn();
    const ctx = guestContext(666);

    await tierGuardMiddleware(ctx, next);

    expect(next).not.toHaveBeenCalled();
  });

  it("lets whitelisted pressers through on guest question buttons", async () => {
    mocked.isAllowedUserMock.mockReturnValue(true);
    const next = vi.fn();
    const ctx = {
      from: { id: 999 },
      callbackQuery: { data: "gq:-100:1" },
      answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
    } as unknown as Context;

    await tierGuardMiddleware(ctx, next);

    expect(next).toHaveBeenCalledOnce();
  });
});
