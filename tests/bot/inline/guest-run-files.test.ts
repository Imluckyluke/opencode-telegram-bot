import { beforeEach, describe, expect, it, vi } from "vitest";

const sessionMessagesMock = vi.hoisted(() => vi.fn());

vi.mock("../../../src/opencode/client.js", () => ({
  opencodeClient: { session: { messages: sessionMessagesMock } },
}));

vi.mock("../../../src/utils/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  collectRunFiles,
  deliverFirstRunFileAsInlineMedia,
} from "../../../src/bot/inline/guest-run-files.js";

function toolPart(
  tool: string,
  state: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return { type: "tool", tool, state, ...overrides };
}

function completedState(input: unknown, metadata: unknown = {}): Record<string, unknown> {
  return { status: "completed", input, metadata, output: "", title: "", time: { start: 1, end: 2 } };
}

describe("bot/inline/guest-run-files", () => {
  beforeEach(() => {
    sessionMessagesMock.mockReset();
  });

  it("collects completed write outputs as files", async () => {
    sessionMessagesMock.mockResolvedValue({
      data: [
        {
          info: { time: { created: 1000 } },
          parts: [
            toolPart("write", completedState({ filePath: "/repo/a.py", content: "print(1)\n" })),
          ],
        },
      ],
      error: null,
    });

    const files = await collectRunFiles("s-1", "/repo", 500);

    expect(files).toHaveLength(1);
    expect(files[0]?.filename).toBe("a.py");
  });

  it("collects edit diffs and skips unfinished or unknown tools", async () => {
    sessionMessagesMock.mockResolvedValue({
      data: [
        {
          info: { time: { created: 1000 } },
          parts: [
            toolPart(
              "edit",
              completedState({}, { filediff: { file: "/repo/b.py" }, diff: "+x\n" }),
            ),
            toolPart("write", { status: "running", input: {} }),
            toolPart("bash", completedState({ command: "ls" })),
            { type: "text", text: "hello" },
          ],
        },
      ],
      error: null,
    });

    const files = await collectRunFiles("s-1", "/repo", 500);

    expect(files).toHaveLength(1);
    expect(files[0]?.filename).toBe("b.py");
  });

  it("ignores messages from before the run and API errors", async () => {
    sessionMessagesMock.mockResolvedValue({
      data: [
        {
          info: { time: { created: 100 } },
          parts: [toolPart("write", completedState({ filePath: "/repo/old.py", content: "old" }))],
        },
      ],
      error: null,
    });

    await expect(collectRunFiles("s-1", "/repo", 500)).resolves.toEqual([]);

    sessionMessagesMock.mockResolvedValue({ data: null, error: new Error("down") });
    await expect(collectRunFiles("s-1", "/repo", 500)).resolves.toEqual([]);
  });

  it("replaces the guest placeholder with the uploaded document", async () => {
    const editMessageMediaInlineMock = vi.fn().mockResolvedValue(true);
    const deleteMessageMock = vi.fn().mockResolvedValue(undefined);
    const api = {
      sendDocument: vi.fn().mockResolvedValue({
        message_id: 11,
        document: { file_id: "fid-1" },
      }),
      deleteMessage: deleteMessageMock,
      editMessageMediaInline: editMessageMediaInlineMock,
    } as never;
    const files = [{ buffer: Buffer.from("data"), filename: "a.py", caption: "" }];

    const delivered = await deliverFirstRunFileAsInlineMedia(api, 777, "inline-1", files, "Done");

    expect(delivered).toBe(true);
    expect(deleteMessageMock).toHaveBeenCalledWith(777, 11);
    expect(editMessageMediaInlineMock).toHaveBeenCalledWith("inline-1", {
      type: "document",
      media: "fid-1",
      caption: "Done",
    });
  });

  it("lists extra files in the caption", async () => {
    const editMessageMediaInlineMock = vi.fn().mockResolvedValue(true);
    const api = {
      sendDocument: vi.fn().mockResolvedValue({
        message_id: 11,
        document: { file_id: "fid-1" },
      }),
      deleteMessage: vi.fn().mockResolvedValue(undefined),
      editMessageMediaInline: editMessageMediaInlineMock,
    } as never;
    const files = [
      { buffer: Buffer.from("a"), filename: "a.py", caption: "" },
      { buffer: Buffer.from("b"), filename: "b.py", caption: "" },
    ];

    await deliverFirstRunFileAsInlineMedia(api, 777, "inline-1", files, "Done");

    expect(editMessageMediaInlineMock).toHaveBeenCalledWith(
      "inline-1",
      expect.objectContaining({
        media: "fid-1",
        caption: expect.stringContaining("b.py"),
      }),
    );
  });

  it("leaves the placeholder alone when there is nothing to deliver", async () => {
    const sendDocumentMock = vi.fn();
    const editMessageMediaInlineMock = vi.fn();
    const api = {
      sendDocument: sendDocumentMock,
      deleteMessage: vi.fn(),
      editMessageMediaInline: editMessageMediaInlineMock,
    } as unknown as import("grammy").Bot<import("grammy").Context>["api"];

    await expect(deliverFirstRunFileAsInlineMedia(api, 777, "inline-1", [], "Done")).resolves.toBe(
      false,
    );
    expect(sendDocumentMock).not.toHaveBeenCalled();
    expect(editMessageMediaInlineMock).not.toHaveBeenCalled();
  });

  it("leaves the placeholder alone when the upload yields no file id", async () => {
    const editMessageMediaInlineMock = vi.fn();
    const api = {
      sendDocument: vi.fn().mockResolvedValue({ message_id: 11 }),
      deleteMessage: vi.fn(),
      editMessageMediaInline: editMessageMediaInlineMock,
    } as never;
    const files = [{ buffer: Buffer.from("a"), filename: "a.py", caption: "" }];

    await expect(
      deliverFirstRunFileAsInlineMedia(api, 777, "inline-1", files, "Done"),
    ).resolves.toBe(false);
    expect(editMessageMediaInlineMock).not.toHaveBeenCalled();
  });
});
