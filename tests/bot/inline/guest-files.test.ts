import { beforeEach, describe, expect, it, vi } from "vitest";
import { prepareGuestFiles } from "../../../src/bot/inline/guest-files.js";

const mocked = vi.hoisted(() => ({
  downloadTelegramFileMock: vi.fn(),
  getModelCapabilitiesMock: vi.fn(),
  extractDocumentMock: vi.fn(),
  isDocExtractorConfiguredMock: vi.fn(() => false),
  isSttConfiguredMock: vi.fn(() => false),
  transcribeAudioMock: vi.fn(),
}));

vi.mock("../../../src/app/services/file-download-service.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../../src/app/services/file-download-service.js")>();
  return {
    ...original,
    downloadTelegramFile: mocked.downloadTelegramFileMock,
  };
});

vi.mock("../../../src/app/services/model-capabilities-service.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../../src/app/services/model-capabilities-service.js")>();
  return {
    ...original,
    getModelCapabilities: mocked.getModelCapabilitiesMock,
  };
});

vi.mock("../../../src/app/services/document-extractor-service.js", () => ({
  extractDocument: mocked.extractDocumentMock,
  isDocExtractorConfigured: mocked.isDocExtractorConfiguredMock,
}));

vi.mock("../../../src/app/services/stt-service.js", () => ({
  isSttConfigured: mocked.isSttConfiguredMock,
  transcribeAudio: mocked.transcribeAudioMock,
}));

const MODEL = { providerID: "opencode", modelID: "m" };

describe("bot/inline/guest-files", () => {
  beforeEach(() => {
    mocked.downloadTelegramFileMock.mockReset().mockResolvedValue({ buffer: Buffer.from("data") });
    mocked.getModelCapabilitiesMock.mockReset().mockResolvedValue({ input: {} });
    mocked.extractDocumentMock.mockReset();
    mocked.isDocExtractorConfiguredMock.mockReset().mockReturnValue(false);
    mocked.isSttConfiguredMock.mockReset().mockReturnValue(false);
    mocked.transcribeAudioMock.mockReset();
  });

  it("flags video skipped for models without video input", async () => {
    const result = await prepareGuestFiles({} as never, MODEL, [
      { kind: "document", fileId: "v1", mime: "video/mp4", filename: "a.mp4" },
    ]);

    expect(result.videoUnsupported).toBe(true);
    expect(result.fileParts).toEqual([]);
    expect(result.prependText).toBe("");
  });

  it("sends video natively when the model supports it", async () => {
    mocked.getModelCapabilitiesMock.mockResolvedValue({ input: { video: true } });

    const result = await prepareGuestFiles({} as never, MODEL, [
      { kind: "document", fileId: "v1", mime: "video/mp4", filename: "a.mp4" },
    ]);

    expect(result.videoUnsupported).toBe(false);
    expect(result.fileParts).toHaveLength(1);
    expect(result.fileParts[0]).toMatchObject({ type: "file", mime: "video/mp4" });
  });

  it("skips oversized files", async () => {
    const result = await prepareGuestFiles({} as never, MODEL, [
      { kind: "photo", fileId: "p1", fileSize: 11 * 1024 * 1024 },
    ]);

    expect(result.fileParts).toEqual([]);
    expect(mocked.downloadTelegramFileMock).not.toHaveBeenCalled();
  });
});
