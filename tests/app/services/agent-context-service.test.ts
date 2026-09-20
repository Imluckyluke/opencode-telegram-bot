import { describe, expect, it, vi, afterEach } from "vitest";
import {
  DEFAULT_AGENT_CONTEXT_NOTE,
  withAgentContext,
} from "../../../src/app/services/agent-context-service.js";

describe("withAgentContext", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("prepends the default note to user text", () => {
    vi.stubEnv("AGENT_CONTEXT_NOTE", "");
    // empty env falls back to default (falsy -> default per helper)
    const result = withAgentContext("do X");
    expect(result).toContain("do X");
    expect(result).toContain(DEFAULT_AGENT_CONTEXT_NOTE);
  });

  it("returns text untouched when disabled", () => {
    vi.stubEnv("AGENT_CONTEXT_NOTE", "off");
    expect(withAgentContext("do X")).toBe("do X");
  });

  it("uses a custom note when provided", () => {
    vi.stubEnv("AGENT_CONTEXT_NOTE", "custom ctx");
    expect(withAgentContext("do X")).toBe("[Note: custom ctx]\ndo X");
  });
});
