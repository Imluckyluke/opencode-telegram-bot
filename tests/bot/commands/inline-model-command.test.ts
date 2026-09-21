import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Context } from "grammy";
import { inlineModelCommand } from "../../../src/bot/commands/inline-model-command.js";
import { t } from "../../../src/i18n/index.js";

const mocked = vi.hoisted(() => ({
  getProviderModelsMock: vi.fn(),
  getInlineModelMock: vi.fn(),
  setInlineModelMock: vi.fn(),
  clearInlineModelMock: vi.fn(),
}));

vi.mock("../../../src/app/services/model-selection-service.js", () => ({
  getProviderModels: mocked.getProviderModelsMock,
}));

vi.mock("../../../src/app/stores/settings-store.js", () => ({
  getInlineModel: mocked.getInlineModelMock,
  setInlineModel: mocked.setInlineModelMock,
  clearInlineModel: mocked.clearInlineModelMock,
}));

function createContext(text: string): Context {
  return {
    message: { text },
    reply: vi.fn().mockResolvedValue(undefined),
  } as unknown as Context;
}

describe("bot/commands/inline-model-command", () => {
  beforeEach(() => {
    mocked.getProviderModelsMock.mockReset().mockResolvedValue([]);
    mocked.getInlineModelMock.mockReset().mockReturnValue(undefined);
    mocked.setInlineModelMock.mockReset();
    mocked.clearInlineModelMock.mockReset();
  });

  it("shows usage and following-default when no args and nothing set", async () => {
    const ctx = createContext("/inlinemodel");

    await inlineModelCommand(ctx as never);

    expect(ctx.reply).toHaveBeenCalledWith(t("inlinemodel.following"));
    expect(ctx.reply).toHaveBeenCalledWith(t("inlinemodel.usage"));
    expect(mocked.setInlineModelMock).not.toHaveBeenCalled();
  });

  it("shows the stored inline model when set", async () => {
    mocked.getInlineModelMock.mockReturnValue({ providerID: "opencode", modelID: "x" });
    const ctx = createContext("/inlinemodel");

    await inlineModelCommand(ctx as never);

    expect(ctx.reply).toHaveBeenCalledWith(
      t("inlinemodel.current", { model: "opencode/x" }),
    );
  });

  it("sets a valid catalog model", async () => {
    mocked.getProviderModelsMock.mockResolvedValue([
      { providerID: "opencode", modelID: "mimo-v2.6-flash-free" },
    ]);
    const ctx = createContext("/inlinemodel opencode/mimo-v2.6-flash-free");

    await inlineModelCommand(ctx as never);

    expect(mocked.setInlineModelMock).toHaveBeenCalledWith({
      providerID: "opencode",
      modelID: "mimo-v2.6-flash-free",
      variant: undefined,
    });
    expect(ctx.reply).toHaveBeenCalledWith(
      t("inlinemodel.saved", { model: "opencode/mimo-v2.6-flash-free" }),
    );
  });

  it("rejects unknown models when the catalog is available", async () => {
    mocked.getProviderModelsMock.mockResolvedValue([
      { providerID: "opencode", modelID: "mimo-v2.6-flash-free" },
    ]);
    const ctx = createContext("/inlinemodel opencode/nope");

    await inlineModelCommand(ctx as never);

    expect(mocked.setInlineModelMock).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledWith(t("inlinemodel.invalid"));
  });

  it("resets to default", async () => {
    const ctx = createContext("/inlinemodel default");

    await inlineModelCommand(ctx as never);

    expect(mocked.clearInlineModelMock).toHaveBeenCalledTimes(1);
    expect(ctx.reply).toHaveBeenCalledWith(t("inlinemodel.cleared"));
  });
});
