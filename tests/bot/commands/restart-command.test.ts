import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Context } from "grammy";
import {
  RESTART_CANCEL_CALLBACK,
  RESTART_CONFIRM_CALLBACK,
  handleRestartCallback,
  restartCommand,
} from "../../../src/bot/commands/restart-command.js";
import { t } from "../../../src/i18n/index.js";

const isAllowedTelegramUserMock = vi.hoisted(() => vi.fn());

vi.mock("../../../src/config.js", () => ({
  isAllowedTelegramUser: isAllowedTelegramUserMock,
  config: {
    telegram: { allowedUserIds: [] },
    opencode: { apiUrl: "http://localhost:4096", username: "opencode", password: "" },
  },
  buildTelegramConfig: vi.fn(),
  parseInitialSettingsPreset: vi.fn(() => ({})),
  DEFAULT_AGENT_CONTEXT_NOTE: "",
}));

function createCommandContext(): Context {
  return {
    from: { id: 111 },
    reply: vi.fn().mockResolvedValue(undefined),
  } as unknown as Context;
}

function createCallbackContext(data: string | undefined): Context {
  return {
    from: { id: 111 },
    callbackQuery: { data },
    reply: vi.fn().mockResolvedValue(undefined),
    answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
    deleteMessage: vi.fn().mockResolvedValue(undefined),
  } as unknown as Context;
}

describe("bot/commands/restart-command", () => {
  beforeEach(() => {
    isAllowedTelegramUserMock.mockReset().mockReturnValue(true);
    vi.useFakeTimers();
  });

  it("refuses non-owners", async () => {
    isAllowedTelegramUserMock.mockReturnValue(false);
    const ctx = createCommandContext();

    await restartCommand(ctx as never);

    expect(ctx.reply).toHaveBeenCalledWith(t("tier.blocked"));
  });

  it("asks for confirmation instead of restarting immediately", async () => {
    const ctx = createCommandContext();
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {}) as never);

    await restartCommand(ctx as never);
    vi.advanceTimersByTime(5000);

    expect(ctx.reply).toHaveBeenCalledWith(
      t("restart.confirm_text"),
      expect.objectContaining({ reply_markup: expect.anything() }),
    );
    expect(exitSpy).not.toHaveBeenCalled();
    exitSpy.mockRestore();
  });

  it("restarts only after the confirm button", async () => {
    const ctx = createCallbackContext(RESTART_CONFIRM_CALLBACK);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {}) as never);

    const handled = await handleRestartCallback(ctx);

    expect(handled).toBe(true);
    expect(ctx.reply).toHaveBeenCalledWith(t("restart.scheduled"));
    expect(exitSpy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1500);
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });

  it("cancels without restarting", async () => {
    const ctx = createCallbackContext(RESTART_CANCEL_CALLBACK);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {}) as never);

    const handled = await handleRestartCallback(ctx);

    expect(handled).toBe(true);
    expect(ctx.reply).not.toHaveBeenCalled();
    vi.advanceTimersByTime(5000);
    expect(exitSpy).not.toHaveBeenCalled();
    exitSpy.mockRestore();
  });

  it("ignores unrelated callbacks", async () => {
    const ctx = createCallbackContext("deletesessions:confirm");

    await expect(handleRestartCallback(ctx)).resolves.toBe(false);
  });

  it("blocks non-owners on the callback", async () => {
    isAllowedTelegramUserMock.mockReturnValue(false);
    const ctx = createCallbackContext(RESTART_CONFIRM_CALLBACK);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {}) as never);

    const handled = await handleRestartCallback(ctx);

    expect(handled).toBe(true);
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({ text: t("tier.blocked") });
    vi.advanceTimersByTime(5000);
    expect(exitSpy).not.toHaveBeenCalled();
    exitSpy.mockRestore();
  });
});
