import { describe, expect, it } from "vitest";
import {
  __resetInlineRunStateForTests,
  cancelInlineRuns,
  currentInlineRunGeneration,
  guestRunKey,
  isInlineRunInFlight,
  setInlineRunInFlight,
} from "../../../src/bot/inline/inline-run-state.js";

describe("bot/inline/inline-run-state", () => {
  it("tracks the in-flight flag", () => {
    __resetInlineRunStateForTests();

    expect(isInlineRunInFlight()).toBe(false);
    setInlineRunInFlight(true);
    expect(isInlineRunInFlight()).toBe(true);
    setInlineRunInFlight(false);
    expect(isInlineRunInFlight()).toBe(false);
  });

  it("cancel releases the flag and advances the generation", () => {
    __resetInlineRunStateForTests();
    setInlineRunInFlight(true);
    const generation = currentInlineRunGeneration();

    cancelInlineRuns();

    expect(isInlineRunInFlight()).toBe(false);
    expect(currentInlineRunGeneration()).toBe(generation + 1);

    __resetInlineRunStateForTests();
  });

  it("tracks guest chats independently so they run in parallel", () => {
    __resetInlineRunStateForTests();

    setInlineRunInFlight(true, guestRunKey(-100));

    expect(isInlineRunInFlight(guestRunKey(-100))).toBe(true);
    expect(isInlineRunInFlight(guestRunKey(-200))).toBe(false);
    expect(isInlineRunInFlight()).toBe(false);

    setInlineRunInFlight(false, guestRunKey(-100));
    expect(isInlineRunInFlight(guestRunKey(-100))).toBe(false);

    __resetInlineRunStateForTests();
  });
});
