import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __resetAgentButtonOverflowForTests,
  agentButtonValueFromUrl,
  encodeAgentButtonCallback,
  isAgentButtonUrl,
  parseAgentButtonCallback,
  resolveAgentButtonValue,
} from "../../../src/bot/inline/agent-buttons.js";

describe("bot/inline/agent-buttons", () => {
  afterEach(() => {
    __resetAgentButtonOverflowForTests();
    vi.useRealTimers();
  });

  it("detects button links and reads their tap value", () => {
    expect(isAgentButtonUrl("btn:railway")).toBe(true);
    expect(isAgentButtonUrl("https://example.com")).toBe(false);
    expect(agentButtonValueFromUrl("btn:railway", "Railway")).toBe("railway");
    expect(agentButtonValueFromUrl("btn:", "Railway")).toBe("Railway");
    expect(agentButtonValueFromUrl("btn:  ", "Railway")).toBe("Railway");
  });

  it("embeds short values directly in callback_data", () => {
    expect(encodeAgentButtonCallback("railway")).toBe("ab:railway");
    expect(encodeAgentButtonCallback("گزینه یک")).toBe("ab:گزینه یک");
  });

  it("round-trips inline taps without stored state", () => {
    const parsed = parseAgentButtonCallback("ab:railway");

    expect(parsed).toEqual({ kind: "inline", value: "railway" });
    expect(resolveAgentButtonValue(parsed)).toBe("railway");
  });

  it("stores long values in the overflow table", () => {
    const long = "x".repeat(200);
    const data = encodeAgentButtonCallback(long);

    expect(data.startsWith("abk:")).toBe(true);
    const parsed = parseAgentButtonCallback(data);
    expect(parsed?.kind).toBe("key");
    expect(resolveAgentButtonValue(parsed)).toBe(long);
  });

  it("rejects unknown callbacks and empty values", () => {
    expect(parseAgentButtonCallback("session:abc")).toBeNull();
    expect(parseAgentButtonCallback("ab:")).toBeNull();
    expect(parseAgentButtonCallback("abk:")).toBeNull();
    expect(parseAgentButtonCallback("no-colon")).toBeNull();
    expect(resolveAgentButtonValue(null)).toBeNull();
    expect(resolveAgentButtonValue(parseAgentButtonCallback("abk:missing"))).toBeNull();
  });

  it("expires overflow entries after a day", () => {
    vi.useFakeTimers().setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const data = encodeAgentButtonCallback("y".repeat(200));
    const parsed = parseAgentButtonCallback(data);

    vi.setSystemTime(new Date("2026-01-02T00:00:01Z"));

    expect(resolveAgentButtonValue(parsed)).toBeNull();
  });
});
