import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildDefaultContextNote,
  DEFAULT_AGENT_CONTEXT_NOTE,
  stripAgentContext,
  withAgentContext,
} from "../../../src/app/services/agent-context-service.js";

describe("agent-context-service", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("prepends the default note to user text", () => {
    vi.stubEnv("AGENT_CONTEXT_NOTE", "");
    vi.stubEnv("GH_TOKEN", "");

    expect(withAgentContext("do X")).toBe(`[Note: ${buildDefaultContextNote()}]\ndo X`);
  });

  it("returns text untouched when disabled", () => {
    vi.stubEnv("AGENT_CONTEXT_NOTE", "off");

    expect(withAgentContext("do X")).toBe("do X");
  });

  it("uses a custom note when provided", () => {
    vi.stubEnv("AGENT_CONTEXT_NOTE", "custom ctx");

    expect(withAgentContext("do X")).toBe("[Note: custom ctx]\ndo X");
  });

  it("mentions GitHub push only when GH_TOKEN is set", () => {
    vi.stubEnv("GH_TOKEN", "");
    expect(buildDefaultContextNote()).not.toContain("GH_TOKEN");

    vi.stubEnv("GH_TOKEN", "ghp_test");
    expect(buildDefaultContextNote()).toContain("GH_TOKEN");
  });

  it("keeps the legacy default with the GitHub sentence", () => {
    expect(DEFAULT_AGENT_CONTEXT_NOTE).toContain("GH_TOKEN");
  });

  it("strips an injected leading note", () => {
    expect(stripAgentContext("[Note: anything here]\ndo X")).toBe("do X");
    expect(stripAgentContext("[Note: a]\n[Note: b]\ndo X")).toBe("do X");
    expect(stripAgentContext("do X")).toBe("do X");
    expect(stripAgentContext("[Note: only a note]")).toBe("");
  });
});
