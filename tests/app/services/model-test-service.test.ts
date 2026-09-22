import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  collectModelProbeTargets,
  MODEL_PROBE_MAX_TARGETS,
  probeModel,
} from "../../../src/app/services/model-test-service.js";

const mocked = vi.hoisted(() => ({
  getStoredModelMock: vi.fn(),
  getStoredInlineModelMock: vi.fn(),
  getModelSelectionListsMock: vi.fn(),
  providersMock: vi.fn(),
  sessionCreateMock: vi.fn(),
  sessionPromptAsyncMock: vi.fn(),
  sessionMessagesMock: vi.fn(),
  registerIgnoreMock: vi.fn(),
  removeIgnoreMock: vi.fn(),
}));

vi.mock("../../../src/app/services/model-selection-service.js", () => ({
  getStoredModel: mocked.getStoredModelMock,
  getStoredInlineModel: mocked.getStoredInlineModelMock,
  getModelSelectionLists: mocked.getModelSelectionListsMock,
}));

vi.mock("../../../src/opencode/client.js", () => ({
  opencodeClient: {
    config: { providers: mocked.providersMock },
    session: {
      create: mocked.sessionCreateMock,
      promptAsync: mocked.sessionPromptAsyncMock,
      messages: mocked.sessionMessagesMock,
    },
  },
}));

vi.mock("../../../src/app/services/scheduled-task-session-ignore-service.js", () => ({
  registerScheduledTaskSessionIgnore: mocked.registerIgnoreMock,
  removeScheduledTaskSessionIgnore: mocked.removeIgnoreMock,
}));

describe("app/services/model-test-service", () => {
  beforeEach(() => {
    mocked.getStoredModelMock.mockReset().mockReturnValue({
      providerID: "opencode",
      modelID: "big-pickle",
    });
    mocked.getStoredInlineModelMock.mockReset().mockReturnValue({
      providerID: "opencode",
      modelID: "mimo",
    });
    mocked.getModelSelectionListsMock.mockReset().mockResolvedValue({
      favorites: [{ providerID: "openai", modelID: "gpt-5" }],
      recent: [],
    });
    mocked.providersMock.mockReset().mockResolvedValue({
      data: {
        providers: [
          { id: "opencode", models: { "m1-free": {}, "m2": {} } },
        ],
      },
      error: null,
    });
    mocked.sessionCreateMock.mockReset().mockResolvedValue({
      data: { id: "probe-session", title: "t" },
      error: null,
    });
    mocked.sessionPromptAsyncMock.mockReset().mockResolvedValue({ data: {}, error: null });
    mocked.sessionMessagesMock.mockReset().mockResolvedValue({ data: [], error: null });
    mocked.registerIgnoreMock.mockReset().mockResolvedValue(undefined);
    mocked.removeIgnoreMock.mockReset().mockResolvedValue(undefined);
  });

  it("collects defaults, favorites, and free-named models deduped and capped", async () => {
    const targets = await collectModelProbeTargets();
    const keys = targets.map((target) => `${target.providerID}/${target.modelID}`);

    expect(keys).toContain("opencode/big-pickle");
    expect(keys).toContain("opencode/mimo");
    expect(keys).toContain("openai/gpt-5");
    expect(keys).toContain("opencode/m1-free");
    expect(keys).not.toContain("opencode/m2");
    expect(targets.length).toBeLessThanOrEqual(MODEL_PROBE_MAX_TARGETS);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("reports success on assistant completion", async () => {
    mocked.sessionMessagesMock.mockResolvedValue({
      data: [
        {
          info: { role: "assistant", time: { created: Date.now(), completed: Date.now() } },
          parts: [{ type: "text", text: "OK" }],
        },
      ],
      error: null,
    });

    const result = await probeModel(
      "/repo",
      { providerID: "opencode", modelID: "m1-free", source: "free-tier" },
      5000,
    );

    expect(result.ok).toBe(true);
    expect(result.snippet).toContain("OK");
    expect(typeof result.latencyMs).toBe("number");
    expect(mocked.sessionPromptAsyncMock).toHaveBeenCalledWith(
      expect.objectContaining({
        model: { providerID: "opencode", modelID: "m1-free" },
      }),
    );
    expect(mocked.removeIgnoreMock).toHaveBeenCalledWith("probe-session");
  });

  it("reports prompt errors with reasons", async () => {
    mocked.sessionPromptAsyncMock.mockResolvedValue({
      data: null,
      error: new Error("overloaded"),
    });

    const result = await probeModel(
      "/repo",
      { providerID: "opencode", modelID: "m1-free", source: "free-tier" },
      5000,
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain("overloaded");
  });

  it("times out without completion", async () => {
    const result = await probeModel(
      "/repo",
      { providerID: "opencode", modelID: "m1-free", source: "free-tier" },
      50,
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain("timeout");
  }, 10000);
});
