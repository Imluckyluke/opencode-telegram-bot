import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  shouldSendLongOutputAsFile,
  sendLongOutputAsFile,
} from "../../../src/bot/messages/send-output-file.js";

describe("bot/messages/send-output-file", () => {
  const OLD_ENV = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    process.env = { ...OLD_ENV };
  });

  it("does not trigger for short text", () => {
    expect(shouldSendLongOutputAsFile("hi")).toBe(false);
    expect(shouldSendLongOutputAsFile("")).toBe(false);
    expect(shouldSendLongOutputAsFile(null)).toBe(false);
    expect(shouldSendLongOutputAsFile(undefined)).toBe(false);
  });

  it("triggers for text longer than the threshold", () => {
    expect(shouldSendLongOutputAsFile("x".repeat(25000))).toBe(true);
  });

  it("sends the full text as a document", async () => {
    const sendDocument = vi.fn().mockResolvedValue({ message_id: 1 });
    const ok = await sendLongOutputAsFile({
      api: { sendDocument } as never,
      chatId: 123,
      text: "hello world",
      filename: "output-test.md",
    });

    expect(ok).toBe(true);
    expect(sendDocument).toHaveBeenCalledTimes(1);
    const [chatId, , options] = sendDocument.mock.calls[0] as unknown as [
      number,
      { filename?: string },
      { caption?: string },
    ];
    expect(chatId).toBe(123);
    expect(options?.caption?.length ?? 0).toBeGreaterThan(0);
  });

  it("returns false when text is empty", async () => {
    const sendDocument = vi.fn();
    const ok = await sendLongOutputAsFile({
      api: { sendDocument } as never,
      chatId: 1,
      text: "",
    });

    expect(ok).toBe(false);
    expect(sendDocument).not.toHaveBeenCalled();
  });

  it("returns false when Telegram rejects the upload", async () => {
    const sendDocument = vi.fn().mockRejectedValue(new Error("nope"));
    const ok = await sendLongOutputAsFile({
      api: { sendDocument } as never,
      chatId: 1,
      text: "hello",
    });

    expect(ok).toBe(false);
  });
});
