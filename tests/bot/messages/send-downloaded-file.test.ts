import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Context } from "grammy";

const projectHolder = vi.hoisted(() => ({ worktree: null as string | null }));

vi.mock("../../../src/utils/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../../../src/app/stores/settings-store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/app/stores/settings-store.js")>();
  return {
    ...actual,
    getCurrentProject: () =>
      projectHolder.worktree ? { id: "project-1", worktree: projectHolder.worktree } : null,
  };
});

import { sendDownloadedFile } from "../../../src/bot/messages/send-downloaded-file.js";

function createContext(): { ctx: Context; replyMock: ReturnType<typeof vi.fn> } {
  const replyMock = vi.fn().mockResolvedValue({ message_id: 1 });
  const ctx = {
    from: { id: 777 },
    chat: { id: 777 },
    reply: replyMock,
    replyWithDocument: vi.fn().mockResolvedValue({}),
  } as unknown as Context;
  return { ctx, replyMock };
}

describe("bot/messages/send-downloaded-file", () => {
  let tempRoot: string;
  let projectDir: string;

  beforeEach(async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), "send-downloaded-file-"));
    projectDir = path.join(tempRoot, "project");
    await mkdir(projectDir, { recursive: true });
    projectHolder.worktree = projectDir;
  });

  afterEach(async () => {
    projectHolder.worktree = null;
    await rm(tempRoot, { recursive: true, force: true });
  });

  it("refuses paths outside the project root", async () => {
    const outside = path.join(tempRoot, "outside.txt");
    await writeFile(outside, "secret");
    const { ctx, replyMock } = createContext();

    expect(await sendDownloadedFile(ctx, outside)).toBe(false);
    expect(replyMock).toHaveBeenCalledTimes(1);
    expect(ctx.replyWithDocument).not.toHaveBeenCalled();
  });

  it("sends files inside the project root", async () => {
    const inside = path.join(projectDir, "notes.txt");
    await writeFile(inside, "hello");
    const { ctx } = createContext();

    expect(await sendDownloadedFile(ctx, inside)).toBe(true);
    expect(ctx.replyWithDocument).toHaveBeenCalledTimes(1);
  });
});
