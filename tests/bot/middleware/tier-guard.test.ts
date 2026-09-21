import { describe, expect, it, vi } from "vitest";
import type { Context } from "grammy";
import { tierGuardMiddleware } from "../../../src/bot/middleware/tier-guard.js";
import { t } from "../../../src/i18n/index.js";

const mocked = vi.hoisted(() => ({
  isAllowedTelegramUserMock: vi.fn(),
}));

vi.mock("../../../src/config.js", () => ({
  isAllowedTelegramUser: mocked.isAllowedTelegramUserMock,
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
  it("lets owners through without checks", async () => {
    mocked.isAllowedTelegramUserMock.mockReturnValue(true);
    const next = vi.fn();
    const ctx = messageContext("/settings");

    await tierGuardMiddleware(ctx, next);

    expect(next).toHaveBeenCalledOnce();
    expect(ctx.reply).not.toHaveBeenCalled();
  });

  it("blocks settings commands for granted users", async () => {
    mocked.isAllowedTelegramUserMock.mockReturnValue(false);
    const next = vi.fn();
    const ctx = messageContext("/settings");

    await tierGuardMiddleware(ctx, next);

    expect(next).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledWith(t("tier.blocked"));
  });

  it("allows normal prompts for granted users", async () => {
    mocked.isAllowedTelegramUserMock.mockReturnValue(false);
    const next = vi.fn();
    const ctx = messageContext("do the thing");

    await tierGuardMiddleware(ctx, next);

    expect(next).toHaveBeenCalledOnce();
  });

  it("allows /sessions for granted users", async () => {
    mocked.isAllowedTelegramUserMock.mockReturnValue(false);
    const next = vi.fn();
    const ctx = messageContext("/sessions");

    await tierGuardMiddleware(ctx, next);

    expect(next).toHaveBeenCalledOnce();
  });

  it("blocks settings callbacks for granted users", async () => {
    mocked.isAllowedTelegramUserMock.mockReturnValue(false);
    const next = vi.fn();
    const ctx = callbackContext("settings:tts");

    await tierGuardMiddleware(ctx, next);

    expect(next).not.toHaveBeenCalled();
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({
      text: t("tier.blocked"),
      show_alert: true,
    });
  });

  it("allows session callbacks for granted users", async () => {
    mocked.isAllowedTelegramUserMock.mockReturnValue(false);
    const next = vi.fn();
    const ctx = callbackContext("session:abc");

    await tierGuardMiddleware(ctx, next);

    expect(next).toHaveBeenCalledOnce();
  });
});
