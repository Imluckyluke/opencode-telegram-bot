import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Context } from "grammy";
import { handleGuestQuestionCallback } from "../../../src/bot/callbacks/guest-question-callback-handler.js";
import {
  __resetPendingGuestQuestionsForTests,
  claimPendingGuestQuestion,
  setPendingGuestQuestion,
} from "../../../src/bot/inline/guest-questions.js";
import { t } from "../../../src/i18n/index.js";

const questionReplyMock = vi.hoisted(() =>
  vi.fn(async (): Promise<{ error: unknown }> => ({ error: null })),
);

vi.mock("../../../src/opencode/client.js", () => ({
  opencodeClient: {
    question: {
      reply: questionReplyMock,
    },
  },
}));

vi.mock("../../../src/utils/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const OPTIONS = [{ label: "Alpha", description: "first" }, { label: "Beta" }];

function createCallbackContext(data: string): Context {
  return {
    from: { id: 999 },
    callbackQuery: { data, message: { message_id: 42 } },
    answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
  } as unknown as Context;
}

function seedPending() {
  setPendingGuestQuestion(-100, {
    sessionId: "s-1",
    directory: "D:\\Repo",
    requestId: "q-1",
    question: "Pick?",
    options: OPTIONS,
    inlineMessageId: "inline-1",
    expiresAt: Date.now() + 5 * 60 * 1000,
  });
}

describe("bot/callbacks/guest-question-callback-handler", () => {
  beforeEach(() => {
    __resetPendingGuestQuestionsForTests();
    questionReplyMock.mockClear();
    questionReplyMock.mockResolvedValue({ error: null });
  });

  it("ignores non guest-question callbacks", async () => {
    const ctx = createCallbackContext("session:abc");

    expect(await handleGuestQuestionCallback(ctx as never)).toBe(false);
    expect(questionReplyMock).not.toHaveBeenCalled();
    expect(ctx.answerCallbackQuery).not.toHaveBeenCalled();
  });

  it("answers stale taps with an inactive notice", async () => {
    const ctx = createCallbackContext("gq:-100:0");

    expect(await handleGuestQuestionCallback(ctx as never)).toBe(true);
    expect(questionReplyMock).not.toHaveBeenCalled();
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({
      text: t("inline.inactive_callback"),
      show_alert: true,
    });
  });

  it("submits the tapped option and consumes the pending entry", async () => {
    seedPending();
    const ctx = createCallbackContext("gq:-100:1");

    expect(await handleGuestQuestionCallback(ctx as never)).toBe(true);

    expect(questionReplyMock).toHaveBeenCalledWith({
      requestID: "q-1",
      directory: "D:\\Repo",
      answers: [["* Beta: "]],
    });
    expect(claimPendingGuestQuestion(-100)).toBeNull();
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({ text: "✓ Beta" });
  });

  it("drops out-of-range taps", async () => {
    seedPending();
    const ctx = createCallbackContext("gq:-100:9");

    expect(await handleGuestQuestionCallback(ctx as never)).toBe(true);

    expect(questionReplyMock).not.toHaveBeenCalled();
    expect(claimPendingGuestQuestion(-100)).toBeNull();
  });

  it("keeps the entry for retry when submit fails", async () => {
    questionReplyMock.mockResolvedValueOnce({ error: new Error("gone") });
    seedPending();
    const ctx = createCallbackContext("gq:-100:0");

    expect(await handleGuestQuestionCallback(ctx as never)).toBe(true);

    expect(claimPendingGuestQuestion(-100)?.requestId).toBe("q-1");
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({
      text: t("callback.processing_error"),
    });
  });
});
