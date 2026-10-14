import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  reload: vi.fn(),
  refreshModelCatalogAfterConfigReload: vi.fn(),
  getStoredModel: vi.fn(),
}));

vi.mock("../../../src/opencode/client.js", () => ({
  opencodeV2Client: { location: { reload: mocked.reload } },
}));

vi.mock("../../../src/opencode/ready-refresh.js", () => ({
  refreshModelCatalogAfterConfigReload: mocked.refreshModelCatalogAfterConfigReload,
}));

vi.mock("../../../src/app/services/model-selection-service.js", () => ({
  getStoredModel: mocked.getStoredModel,
}));

import { reloadOpencodeConfig } from "../../../src/app/services/config-reload-service.js";

const STORED_MODEL = { providerID: "anthropic", modelID: "claude", variant: "default" };
const FALLBACK_MODEL = { providerID: "test-provider", modelID: "test-model", variant: "default" };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("app/services/config-reload-service", () => {
  beforeEach(() => {
    mocked.reload.mockResolvedValue({ data: true, error: undefined });
    mocked.refreshModelCatalogAfterConfigReload.mockResolvedValue(undefined);
    mocked.getStoredModel.mockReturnValue(STORED_MODEL);
  });

  it("refreshes the model catalog after a successful reload", async () => {
    const result = await reloadOpencodeConfig();

    expect(result).toEqual({ kind: "success", modelChanged: false });
    expect(mocked.reload).toHaveBeenCalledOnce();
    expect(mocked.refreshModelCatalogAfterConfigReload).toHaveBeenCalledOnce();
  });

  it("reports a model the catalog refresh replaced", async () => {
    mocked.refreshModelCatalogAfterConfigReload.mockImplementation(async () => {
      mocked.getStoredModel.mockReturnValue(FALLBACK_MODEL);
    });

    await expect(reloadOpencodeConfig()).resolves.toEqual({ kind: "success", modelChanged: true });
  });

  it("still reports success when the catalog refresh fails", async () => {
    mocked.refreshModelCatalogAfterConfigReload.mockRejectedValue(new Error("catalog down"));

    await expect(reloadOpencodeConfig()).resolves.toEqual({ kind: "success", modelChanged: false });
  });

  it("returns the server's error text when the reload is rejected", async () => {
    mocked.reload.mockResolvedValue({
      data: undefined,
      error: new Error("Invalid config: unknown field"),
    });

    await expect(reloadOpencodeConfig()).resolves.toEqual({
      kind: "failed",
      error: "Invalid config: unknown field",
    });
    expect(mocked.refreshModelCatalogAfterConfigReload).not.toHaveBeenCalled();
  });

  it("returns no error text when the error carries none", async () => {
    mocked.reload.mockResolvedValue({ data: undefined, error: {} });

    await expect(reloadOpencodeConfig()).resolves.toEqual({ kind: "failed", error: null });
  });

  it("joins a reload that is already in flight", async () => {
    const pending = deferred<{ data: true; error: undefined }>();
    mocked.reload.mockReturnValue(pending.promise);

    const first = reloadOpencodeConfig();
    const second = reloadOpencodeConfig();
    pending.resolve({ data: true, error: undefined });

    await expect(first).resolves.toEqual({ kind: "success", modelChanged: false });
    await expect(second).resolves.toEqual({ kind: "success", modelChanged: false });
    expect(mocked.reload).toHaveBeenCalledOnce();

    await reloadOpencodeConfig();
    expect(mocked.reload).toHaveBeenCalledTimes(2);
  });

  it("times out without abandoning the catalog refresh of a late success", async () => {
    vi.useFakeTimers();
    const pending = deferred<{ data: true; error: undefined }>();
    mocked.reload.mockReturnValueOnce(pending.promise);

    const result = reloadOpencodeConfig();
    await vi.advanceTimersByTimeAsync(60_000);

    await expect(result).resolves.toEqual({ kind: "timeout" });

    const retry = reloadOpencodeConfig();
    await expect(retry).resolves.toEqual({ kind: "success", modelChanged: false });
    expect(mocked.reload).toHaveBeenCalledTimes(2);

    pending.resolve({ data: true, error: undefined });
    await vi.advanceTimersByTimeAsync(0);
    expect(mocked.refreshModelCatalogAfterConfigReload).toHaveBeenCalledTimes(2);
  });
});
