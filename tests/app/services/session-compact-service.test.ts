import { describe, expect, it } from "vitest";
import {
  resetAutoCompactState,
  shouldAutoCompact,
} from "../../../src/app/services/session-compact-service.js";

describe("session-compact-service shouldAutoCompact", () => {
  it("fires once when usage crosses the threshold from below", () => {
    const session = "session-cross";
    expect(shouldAutoCompact(session, 79, 100, 80)).toBe(false);
    expect(shouldAutoCompact(session, 85, 100, 80)).toBe(true);
    // Stays above: no repeat trigger.
    expect(shouldAutoCompact(session, 90, 100, 80)).toBe(false);
  });

  it("refires after reset (e.g. session switch)", () => {
    const session = "session-reset";
    expect(shouldAutoCompact(session, 85, 100, 80)).toBe(true);
    expect(shouldAutoCompact(session, 90, 100, 80)).toBe(false);
    resetAutoCompactState(session);
    expect(shouldAutoCompact(session, 95, 100, 80)).toBe(true);
  });

  it("rejects invalid inputs", () => {
    expect(shouldAutoCompact("", 90, 100, 80)).toBe(false);
    expect(shouldAutoCompact("s", 90, 100, 0)).toBe(false);
    expect(shouldAutoCompact("s", 90, 100, 101)).toBe(false);
    expect(shouldAutoCompact("s", 90, 0, 80)).toBe(false);
  });
});
