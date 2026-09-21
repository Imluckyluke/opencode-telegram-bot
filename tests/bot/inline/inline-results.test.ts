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
    const results = buildInlineResults("", snapshot);

    expect(results).toHaveLength(1);
    expect(results[0]?.id).toBe(INLINE_STATUS_RESULT_ID);
  });

  it("adds an ask action for non-empty queries and consumes it once", () => {
    const results = buildInlineResults("fix the bug", snapshot);

    expect(results).toHaveLength(2);
    const askId = String(results[0]?.id);
    expect(askId).not.toBe(INLINE_STATUS_RESULT_ID);

    expect(consumePendingInlineQuery(askId)).toBe("fix the bug");
    expect(consumePendingInlineQuery(askId)).toBeNull();
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
