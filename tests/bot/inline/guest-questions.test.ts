import { beforeEach, describe, expect, it, vi } from "vitest";

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

import {
  __resetPendingGuestQuestionsForTests,
  claimPendingGuestQuestion,
  clearPendingGuestQuestion,
  formatGuestAnswer,
  parseGuestAnswerNumber,
  parseGuestQuestionCallback,
  renderGuestQuestionTable,
  requeuePendingGuestQuestion,
  restorePendingGuestQuestion,
  setPendingGuestQuestion,
  submitGuestQuestionAnswer,
} from "../../../src/bot/inline/guest-questions.js";

const OPTIONS = [
  { label: "Alpha", description: "first option" },
  { label: "Beta" },
  { label: "Gamma", description: "third option" },
];

describe("bot/inline/guest-questions", () => {
  beforeEach(() => {
    __resetPendingGuestQuestionsForTests();
    questionReplyMock.mockClear();
    questionReplyMock.mockResolvedValue({ error: null });
  });

  it("parses bare numbers into zero-based indexes", () => {
    expect(parseGuestAnswerNumber("1", 3)).toBe(0);
    expect(parseGuestAnswerNumber(" 3 ", 3)).toBe(2);
    expect(parseGuestAnswerNumber("0", 3)).toBeNull();
    expect(parseGuestAnswerNumber("4", 3)).toBeNull();
    expect(parseGuestAnswerNumber("2x", 3)).toBeNull();
    expect(parseGuestAnswerNumber("hello", 3)).toBeNull();
    expect(parseGuestAnswerNumber("", 3)).toBeNull();
  });

  it("renders a numbered table with the hint", () => {
    const table = renderGuestQuestionTable(
      { question: "Pick one?", options: OPTIONS },
      "Reply with the number.",
    );

    expect(table).toContain("Pick one?");
    expect(table).toContain("1. Alpha — first option");
    expect(table).toContain("2. Beta");
    expect(table).toContain("3. Gamma — third option");
    expect(table).toContain("Reply with the number.");
  });

  it("formats answers like DM answers", () => {
    expect(formatGuestAnswer(OPTIONS, 0)).toBe("* Alpha: first option");
    expect(formatGuestAnswer(OPTIONS, 1)).toBe("* Beta: ");
    expect(formatGuestAnswer(OPTIONS, 9)).toBeNull();
  });

  it("tracks pending questions per chat and sweeps expired ones", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-16T10:00:00.000Z"));
    try {
      const entry = {
        sessionId: "s-1",
        directory: "D:\\Repo",
        requestId: "q-1",
        question: "Pick?",
        options: OPTIONS,
        inlineMessageId: "inline-1",
        expiresAt: Date.now() + 5 * 60 * 1000,
      };
      setPendingGuestQuestion(-100, entry);

      expect(claimPendingGuestQuestion(-200)).toBeNull();

      vi.setSystemTime(new Date("2026-03-16T10:06:00.000Z"));
      expect(claimPendingGuestQuestion(-100)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("lets only the first claimer answer (button vs numbered race)", () => {
    setPendingGuestQuestion(-100, {
      sessionId: "s-1",
      directory: "D:\\Repo",
      requestId: "q-1",
      question: "Pick?",
      options: OPTIONS,
      inlineMessageId: "inline-1",
      expiresAt: Date.now() + 5 * 60 * 1000,
    });

    expect(claimPendingGuestQuestion(-100)?.requestId).toBe("q-1");
    expect(claimPendingGuestQuestion(-100)).toBeNull();
  });

  it("restores entries untouched and requeues them with fresh expiry", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-16T10:00:00.000Z"));
    try {
      const entry = {
        sessionId: "s-1",
        directory: "D:\\Repo",
        requestId: "q-1",
        question: "Pick?",
        options: OPTIONS,
        inlineMessageId: "inline-1",
        expiresAt: Date.now() + 5 * 60 * 1000,
      };
      setPendingGuestQuestion(-100, entry);

      const claimed = claimPendingGuestQuestion(-100);
      expect(claimed?.requestId).toBe("q-1");
      restorePendingGuestQuestion(-100, claimed!);
      expect(claimPendingGuestQuestion(-100)?.requestId).toBe("q-1");

      const claimedAgain = claimPendingGuestQuestion(-100);
      expect(claimedAgain).toBeNull();

      setPendingGuestQuestion(-100, entry);
      const retry = claimPendingGuestQuestion(-100);
      expect(retry?.requestId).toBe("q-1");
      // Requeue with a short original expiry: the fresh 5-minute window
      // outlives it, proving the extension.
      requeuePendingGuestQuestion(-100, { ...retry!, expiresAt: Date.now() + 60_000 });
      vi.setSystemTime(new Date("2026-03-16T10:02:00.000Z"));
      expect(claimPendingGuestQuestion(-100)?.requestId).toBe("q-1");
    } finally {
      vi.useRealTimers();
    }
  });

  it("parses button callback data strictly", () => {
    expect(parseGuestQuestionCallback("gq:-100:2")).toEqual({ chatId: -100, optionIndex: 2 });
    expect(parseGuestQuestionCallback("gq:123:0")).toEqual({ chatId: 123, optionIndex: 0 });
    expect(parseGuestQuestionCallback("session:abc")).toBeNull();
    expect(parseGuestQuestionCallback("gq:abc:1")).toBeNull();
    expect(parseGuestQuestionCallback("gq:123")).toBeNull();
    expect(parseGuestQuestionCallback("gq:123:-1")).toBeNull();
    expect(parseGuestQuestionCallback("gq:123:1:extra")).toBeNull();
  });

  it("submits the selected option to the agent", async () => {
    const pending = {
      sessionId: "s-1",
      directory: "D:\\Repo",
      requestId: "q-1",
      question: "Pick?",
      options: OPTIONS,
      inlineMessageId: "inline-1",
      expiresAt: Date.now() + 5 * 60 * 1000,
    };

    expect(await submitGuestQuestionAnswer(pending, 1)).toBe(true);
    expect(questionReplyMock).toHaveBeenCalledWith({
      requestID: "q-1",
      directory: "D:\\Repo",
      answers: [["* Beta: "]],
    });
  });

  it("reports submit failures without throwing", async () => {
    questionReplyMock.mockResolvedValueOnce({ error: new Error("gone") });
    const pending = {
      sessionId: "s-1",
      directory: "D:\\Repo",
      requestId: "q-1",
      question: "Pick?",
      options: OPTIONS,
      inlineMessageId: "inline-1",
      expiresAt: Date.now() + 5 * 60 * 1000,
    };

    expect(await submitGuestQuestionAnswer(pending, 0)).toBe(false);
  });

  it("clears pending entries on demand", () => {
    setPendingGuestQuestion(-100, {
      sessionId: "s-1",
      directory: "D:\\Repo",
      requestId: "q-1",
      question: "Pick?",
      options: OPTIONS,
      inlineMessageId: "inline-1",
      expiresAt: Date.now() + 5 * 60 * 1000,
    });

    clearPendingGuestQuestion(-100);

    expect(claimPendingGuestQuestion(-100)).toBeNull();
  });
});
