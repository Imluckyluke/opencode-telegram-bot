import { describe, expect, it, vi } from "vitest";

const getAvailableAgentsMock = vi.hoisted(() => vi.fn());

vi.mock("../../../src/app/services/agent-selection-service.js", () => ({
  fetchCurrentAgent: vi.fn(),
  getAvailableAgents: getAvailableAgentsMock,
}));

import {
  buildAgentCallbackData,
  resolveAgentFromCallbackPayload,
} from "../../../src/bot/menus/agent-selection-menu.js";

describe("agent callback data", () => {
  it("keeps short agent names inline", () => {
    expect(buildAgentCallbackData("build", 0)).toBe("agent:build");
  });

  it("falls back to an index when the name would exceed 64 bytes", () => {
    const longName = "агент-".repeat(10);
    const data = buildAgentCallbackData(longName, 3);
    expect(data).toBe("agent:#3");
    expect(Buffer.byteLength(data)).toBeLessThanOrEqual(64);
  });

  it("resolves index payloads against the current agent list", async () => {
    getAvailableAgentsMock.mockResolvedValue([{ name: "a" }, { name: "b" }]);
    await expect(resolveAgentFromCallbackPayload("#1")).resolves.toBe("b");
    await expect(resolveAgentFromCallbackPayload("#9")).resolves.toBeNull();
    await expect(resolveAgentFromCallbackPayload("#x")).resolves.toBeNull();
    await expect(resolveAgentFromCallbackPayload("plan")).resolves.toBe("plan");
  });
});
