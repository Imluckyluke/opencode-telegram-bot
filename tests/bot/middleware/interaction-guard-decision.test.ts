import { afterEach, describe, expect, it } from "vitest";
import type { Context } from "grammy";
import { resolveInteractionGuardDecision } from "../../../src/bot/middleware/interaction-guard-decision.js";
import { interactionManager } from "../../../src/app/managers/interaction-manager.js";
import { foregroundSessionState } from "../../../src/app/managers/foreground-session-state-manager.js";

function inlineQueryContext(): Context {
  return {
    inlineQuery: { id: "q1", from: { id: 1 }, query: "hi", offset: "" },
  } as unknown as Context;
}

function chosenResultContext(): Context {
  return {
    chosenInlineResult: { result_id: "ask:1", from: { id: 1 }, query: "hi" },
  } as unknown as Context;
}

describe("interaction-guard-decision inline updates", () => {
  afterEach(() => {
    interactionManager.clear("inline_decision_test_reset");
    foregroundSessionState.clearAll("inline_decision_test_reset");
  });

  it("allows inline queries with no active interaction", () => {
    const decision = resolveInteractionGuardDecision(inlineQueryContext());

    expect(decision.allow).toBe(true);
    expect(decision.inputType).toBe("inline");
  });

  it("allows chosen inline results with no active interaction", () => {
    const decision = resolveInteractionGuardDecision(chosenResultContext());

    expect(decision.allow).toBe(true);
  });

  it("allows inline updates while the session is busy", () => {
    foregroundSessionState.markBusy("session-1", "/repo");

    expect(resolveInteractionGuardDecision(inlineQueryContext()).allow).toBe(true);
    expect(resolveInteractionGuardDecision(chosenResultContext()).allow).toBe(true);
  });

  it("allows inline updates while an inline menu interaction is open", () => {
    interactionManager.start({
      kind: "inline",
      expectedInput: "callback",
      metadata: { menuKind: "model", messageId: 10 },
    });

    expect(resolveInteractionGuardDecision(chosenResultContext()).allow).toBe(true);
  });
});
