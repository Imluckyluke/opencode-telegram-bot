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

  it("keeps the legacy default with the GitHub sentence", () => {
    expect(DEFAULT_AGENT_CONTEXT_NOTE).toContain("GH_TOKEN");
  });

  it("mentions GitHub push only when GH_TOKEN is set", () => {
    vi.stubEnv("GH_TOKEN", "");
    expect(buildDefaultContextNote()).not.toContain("GH_TOKEN");

    vi.stubEnv("GH_TOKEN", "ghp_test");
    expect(buildDefaultContextNote()).toContain("GH_TOKEN");
  });

  it("hides the GitHub sentence when github is false", () => {
    vi.stubEnv("GH_TOKEN", "ghp_test");
    expect(buildDefaultContextNote({ github: false })).not.toContain("GH_TOKEN");
    expect(withAgentContext("do X", undefined, { github: false })).toBe(
      `[Note: ${buildDefaultContextNote({ github: false })}]\ndo X`,
    );
  });

  it("strips an injected leading note", () => {
    expect(stripAgentContext("[Note: anything here]\ndo X")).toBe("do X");
    expect(stripAgentContext("[Note: a]\n[Note: b]\ndo X")).toBe("do X");
    expect(stripAgentContext("do X")).toBe("do X");
    expect(stripAgentContext("[Note: only a note]")).toBe("");
  });

  it("advertises rich message authoring capabilities to the model", () => {
    const note = buildDefaultContextNote();

    expect(note).toContain("callback_data");
    expect(note).toContain("core.telegram.org/bots/api");
  });

  it("tells the model to deliver file content, not bare paths", () => {
    const note = buildDefaultContextNote();

    expect(note).toContain("cannot open local file paths");
    expect(note).toContain("always write them with your file tools");
    expect(note).toContain("never becomes a downloadable file");
  });
});
