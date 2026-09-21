import { describe, expect, it } from "vitest";
import {
  buildInlineResults,
  consumePendingInlineQuery,
  INLINE_STATUS_RESULT_ID,
  truncateInlineText,
} from "../../../src/bot/inline/inline-results.js";
import type { InlineSnapshot } from "../../../src/bot/inline/inline-results.js";

const snapshot: InlineSnapshot = {
  projectName: "/repo",
  sessionTitle: "Session",
  modelLabel: "openai/gpt-5",
  contextLine: "Context",
};

describe("bot/inline/inline-results", () => {
  it("always includes the status card", () => {
    const results = buildInlineResults("", snapshot, "TestBot");

    expect(results).toHaveLength(1);
    expect(results[0]?.id).toBe(INLINE_STATUS_RESULT_ID);
  });

  it("adds an ask action with a keyboard for in-place edits", () => {
    const results = buildInlineResults("fix the bug", snapshot, "TestBot");

    expect(results).toHaveLength(2);
    const askId = String(results[0]?.id);
    expect(askId).not.toBe(INLINE_STATUS_RESULT_ID);
    expect(results[0]?.reply_markup?.inline_keyboard[0]?.[0]?.url).toBe(
      "https://t.me/TestBot",
    );

    expect(consumePendingInlineQuery(askId)).toBe("fix the bug");
    expect(consumePendingInlineQuery(askId)).toBeNull();
  });

  it("omits the keyboard without a bot username", () => {
    const results = buildInlineResults("fix the bug", snapshot, null);

    expect(results[0]?.reply_markup).toBeUndefined();
  });

  it("rejects unknown result ids", () => {
    expect(consumePendingInlineQuery("ask_unknown")).toBeNull();
    expect(consumePendingInlineQuery(INLINE_STATUS_RESULT_ID)).toBeNull();
  });

  it("truncates long texts with an ellipsis", () => {
    expect(truncateInlineText("short")).toBe("short");
    const long = truncateInlineText("x".repeat(5000));
    expect(long.length).toBeLessThanOrEqual(4000);
    expect(long.endsWith("…")).toBe(true);
  });
});
