import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Context } from "grammy";
import { interactionManager } from "../../../src/app/managers/interaction-manager.js";
import { foregroundSessionState } from "../../../src/app/managers/foreground-session-state-manager.js";

const mocked = vi.hoisted(() => ({
  reloadKnown: true,
}));

vi.mock("../../../src/bot/routers/command-utils.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../src/bot/routers/command-utils.js")>();
  return {
    ...actual,
    isKnownCommand: (command: string) => (command === "reload" ? mocked.reloadKnown : actual.isKnownCommand(command)),
  };
});

import { resolveInteractionGuardDecision } from "../../../src/bot/middleware/interaction-guard-decision.js";

function reloadContext(): Context {
  return { message: { text: "/reload" } } as unknown as Context;
}

describe("interaction guard: /reload", () => {
  beforeEach(() => {
    mocked.reloadKnown = true;
    interactionManager.clear("test_setup");
    foregroundSessionState.__resetForTests();
  });

  it("allows /reload while a task runs and nothing is on screen", () => {
    foregroundSessionState.markBusy("session-1", "D:\\Projects\\Repo");

    const decision = resolveInteractionGuardDecision(reloadContext());

    expect(decision.allow).toBe(true);
    expect(decision.busy).toBe(true);
  });

  it("blocks /reload while a task runs and a question is on screen", () => {
    foregroundSessionState.markBusy("session-1", "D:\\Projects\\Repo");
    interactionManager.start({
      kind: "question",
      expectedInput: "mixed",
    });

    const decision = resolveInteractionGuardDecision(reloadContext());

    expect(decision.allow).toBe(false);
    expect(decision.reason).toBe("command_not_allowed");
  });

  it("blocks /reload while an inline menu is on screen and nothing runs", () => {
    interactionManager.start({
      kind: "inline",
      expectedInput: "callback",
    });

    const decision = resolveInteractionGuardDecision(reloadContext());

    expect(decision.allow).toBe(false);
    expect(decision.reason).toBe("command_not_allowed");
  });

  it("keeps the busy block for /reload when the server version has no such command", () => {
    mocked.reloadKnown = false;
    foregroundSessionState.markBusy("session-1", "D:\\Projects\\Repo");

    const decision = resolveInteractionGuardDecision(reloadContext());

    expect(decision.allow).toBe(false);
    expect(decision.reason).toBe("command_not_allowed");
    expect(decision.busy).toBe(true);
  });
});
