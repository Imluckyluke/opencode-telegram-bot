import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Context } from "grammy";
import { handleAgentButtonCallback } from "../../../src/bot/callbacks/agent-button-callback-handler.js";
import { t } from "../../../src/i18n/index.js";

const processPromptMock = vi.hoisted(() => vi.fn(async () => true));

vi.mock("../../../src/bot/handlers/prompt.js", () => ({
  processUserPrompt: processPromptMock,
}));

vi.mock("../../../src/utils/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

function createCallbackContext(data: string): Context {
  return {
    chat: { id: 999 },
    from: { id: 999 },
    callbackQuery: { data, message: { message_id: 42 } },
    answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
    reply: vi.fn().mockResolvedValue(undefined),
  } as unknown as Context;
}

const DEPS = {
  bot: {} as never,
  ensureEventSubscription: vi.fn(async () => {}),
};

describe("bot/callbacks/agent-button-callback-handler", () => {
  beforeEach(() => {
    processPromptMock.mockClear();
    processPromptMock.mockResolvedValue(true);
  });

  it("ignores callbacks from other features", async () => {
    const ctx = createCallbackContext("session:abc");

    expect(await handleAgentButtonCallback(ctx, DEPS)).toBe(false);
    expect(ctx.answerCallbackQuery).not.toHaveBeenCalled();
    expect(processPromptMock).not.toHaveBeenCalled();
  });

  it("answers stale taps with an inactive notice", async () => {
    const ctx = createCallbackContext("abk:missing");

    expect(await handleAgentButtonCallback(ctx, DEPS)).toBe(true);
    expect(processPromptMock).not.toHaveBeenCalled();
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({
      text: t("inline.inactive_callback"),
      show_alert: true,
    });
  });

  it("injects the tapped value as the next prompt", async () => {
    const ctx = createCallbackContext("ab:railway");

    expect(await handleAgentButtonCallback(ctx, DEPS)).toBe(true);

    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({ text: "✓ railway" });
    expect(processPromptMock).toHaveBeenCalledOnce();
    const call = processPromptMock.mock.calls[0] as
      [Context, { text: string }, typeof DEPS] | undefined;
    expect(call?.[0]).toBe(ctx);
    expect(call?.[1]).toMatchObject({ text: "railway" });
    expect(call?.[2]).toBe(DEPS);
  });

  it("reports a failure toast when the prompt is not delivered", async () => {
    processPromptMock.mockResolvedValueOnce(false);
    const ctx = createCallbackContext("ab:vps");

    expect(await handleAgentButtonCallback(ctx, DEPS)).toBe(true);

    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({
      text: t("callback.processing_error"),
    });
  });
});
