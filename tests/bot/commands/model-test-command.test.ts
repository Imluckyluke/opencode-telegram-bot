import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Context } from "grammy";
import { testModelsCommand } from "../../../src/bot/commands/model-test-command.js";
import { t } from "../../../src/i18n/index.js";

const mocked = vi.hoisted(() => ({
  getCurrentProjectMock: vi.fn(),
  isBusyMock: vi.fn(),
  collectModelProbeTargetsMock: vi.fn(),
  probeModelMock: vi.fn(),
}));

vi.mock("../../../src/app/stores/settings-store.js", () => ({
  getCurrentProject: mocked.getCurrentProjectMock,
}));

vi.mock("../../../src/app/managers/foreground-session-state-manager.js", () => ({
  foregroundSessionState: {
    isBusy: mocked.isBusyMock,
  },
}));

vi.mock("../../../src/app/services/model-test-service.js", () => ({
  collectModelProbeTargets: mocked.collectModelProbeTargetsMock,
  probeModel: mocked.probeModelMock,
}));

function createContext(): Context {
  return {
    chat: { id: 777 },
    api: {
      editMessageText: vi.fn().mockResolvedValue(undefined),
    },
    reply: vi.fn().mockResolvedValue({ message_id: 42 }),
  } as unknown as Context;
}

describe("bot/commands/model-test-command", () => {
  beforeEach(() => {
    mocked.getCurrentProjectMock.mockReset().mockReturnValue({ worktree: "/repo" });
    mocked.isBusyMock.mockReset().mockReturnValue(false);
    mocked.collectModelProbeTargetsMock.mockReset().mockResolvedValue([]);
    mocked.probeModelMock.mockReset();
  });

  it("asks to select a project when none is selected", async () => {
    mocked.getCurrentProjectMock.mockReturnValue(undefined);
    const ctx = createContext();

    await testModelsCommand(ctx as never);

    expect(ctx.reply).toHaveBeenCalledWith(t("bot.project_not_selected"));
    expect(mocked.collectModelProbeTargetsMock).not.toHaveBeenCalled();
  });

  it("refuses to run while a session is busy", async () => {
    mocked.isBusyMock.mockReturnValue(true);
    const ctx = createContext();

    await testModelsCommand(ctx as never);

    expect(ctx.reply).toHaveBeenCalledWith(t("bot.session_busy"));
    expect(mocked.collectModelProbeTargetsMock).not.toHaveBeenCalled();
  });

  it("reports when there is nothing to probe", async () => {
    const ctx = createContext();

    await testModelsCommand(ctx as never);

    expect(ctx.reply).toHaveBeenCalledWith(t("testmodels.empty"));
    expect(mocked.probeModelMock).not.toHaveBeenCalled();
  });

  it("probes every target and edits the final score into the progress message", async () => {
    const targets = [
      { providerID: "opencode", modelID: "model-a" },
      { providerID: "opencode", modelID: "model-b" },
    ];
    mocked.collectModelProbeTargetsMock.mockResolvedValue(targets);
    mocked.probeModelMock
      .mockResolvedValueOnce({ ...targets[0], ok: true, latencyMs: 1200 })
      .mockResolvedValueOnce({ ...targets[1], ok: false, error: "boom" });
    const ctx = createContext();

    await testModelsCommand(ctx as never);

    expect(ctx.reply).toHaveBeenCalledWith(t("testmodels.start", { count: 2 }));
    expect(mocked.probeModelMock).toHaveBeenCalledTimes(2);
    expect(mocked.probeModelMock).toHaveBeenNthCalledWith(1, "/repo", targets[0]);
    const editMessageText = ctx.api.editMessageText as ReturnType<typeof vi.fn>;
    const lastEdit = editMessageText.mock.calls.at(-1) as [number, number, string];
    expect(lastEdit[2]).toContain(`${t("testmodels.header")} 1/2`);
    expect(lastEdit[2]).toContain("✅ opencode/model-a");
    expect(lastEdit[2]).toContain("❌ opencode/model-b — boom");
  });

  it("turns a probe crash into a failed result instead of aborting the run", async () => {
    mocked.collectModelProbeTargetsMock.mockResolvedValue([
      { providerID: "opencode", modelID: "model-a" },
    ]);
    mocked.probeModelMock.mockRejectedValue(new Error("crashed"));
    const ctx = createContext();

    await testModelsCommand(ctx as never);

    const editMessageText = ctx.api.editMessageText as ReturnType<typeof vi.fn>;
    const lastEdit = editMessageText.mock.calls.at(-1) as [number, number, string];
    expect(lastEdit[2]).toContain(`${t("testmodels.header")} 0/1`);
    expect(lastEdit[2]).toContain("❌ opencode/model-a — crashed");
  });
});
