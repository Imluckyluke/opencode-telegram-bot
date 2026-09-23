import { describe, expect, it } from "vitest";
import {
  __resetInlineRunStateForTests,
  cancelInlineRuns,
  currentInlineRunGeneration,
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
});
