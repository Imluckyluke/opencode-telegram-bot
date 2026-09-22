import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { mkdtemp, rm, mkdir, symlink, writeFile } from "node:fs/promises";
import {
  getHomeDirectory,
  pathToDisplayPath,
  scanDirectory,
  buildEntryLabel,
  buildTreeHeader,
  isScanError,
  MAX_ENTRIES_PER_PAGE,
  scanLsDirectory,
  getFileDetails,
  isWithinProjectRootSafe,
} from "../../../src/app/services/file-browser-service.js";
import { defined } from "../../helpers/defined.js";

const projectHolder = vi.hoisted(() => ({ worktree: null as string | null }));

vi.mock("../../../src/app/stores/settings-store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/app/stores/settings-store.js")>();
  return {
    ...actual,
    getCurrentProject: () =>
      projectHolder.worktree ? { id: "project-1", worktree: projectHolder.worktree } : null,
  };
});

vi.mock("../../../src/utils/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

describe("file-tree", () => {
  describe("getHomeDirectory", () => {
    it("should return os.homedir()", () => {
      expect(getHomeDirectory()).toBe(os.homedir());
    });
  });

  describe("pathToDisplayPath", () => {
    it("should replace home directory with ~", () => {
      const home = os.homedir();
      expect(pathToDisplayPath(home)).toBe("~");
    });

    it("should replace home prefix with ~", () => {
      const home = os.homedir();
      const subdir = path.join(home, "projects", "my-app");
      const result = pathToDisplayPath(subdir);
      expect(result).toBe(`~${path.sep}projects${path.sep}my-app`);
    });

    it("should return absolute path unchanged if not under home", () => {
      expect(pathToDisplayPath("/tmp/something")).toBe("/tmp/something");
    });
  });

  describe("scanDirectory", () => {
    let tempDir: string;

    beforeEach(async () => {
      tempDir = await mkdtemp(path.join(os.tmpdir(), "file-tree-test-"));
    });

    afterEach(async () => {
      await rm(tempDir, { recursive: true, force: true });
    });

    it("should list subdirectories sorted alphabetically", async () => {
      await mkdir(path.join(tempDir, "charlie"));
      await mkdir(path.join(tempDir, "alpha"));
      await mkdir(path.join(tempDir, "bravo"));

      const result = await scanDirectory(tempDir);
      expect(isScanError(result)).toBe(false);
      if (isScanError(result)) return;

      expect(result.entries).toHaveLength(3);
      expect(defined(result.entries[0]).name).toBe("alpha");
      expect(defined(result.entries[1]).name).toBe("bravo");
      expect(defined(result.entries[2]).name).toBe("charlie");
      expect(result.totalCount).toBe(3);
    });

    it("should skip hidden directories", async () => {
      await mkdir(path.join(tempDir, ".hidden"));
      await mkdir(path.join(tempDir, "visible"));

      const result = await scanDirectory(tempDir);
      expect(isScanError(result)).toBe(false);
      if (isScanError(result)) return;

      expect(result.entries).toHaveLength(1);
      expect(defined(result.entries[0]).name).toBe("visible");
    });

    it("should skip files (only list directories)", async () => {
      await mkdir(path.join(tempDir, "subdir"));
      await fs.writeFile(path.join(tempDir, "file.txt"), "content");

      const result = await scanDirectory(tempDir);
      expect(isScanError(result)).toBe(false);
      if (isScanError(result)) return;

      expect(result.entries).toHaveLength(1);
      expect(defined(result.entries[0]).name).toBe("subdir");
    });

    it("should paginate entries", async () => {
      // Create more entries than one page
      for (let i = 0; i < MAX_ENTRIES_PER_PAGE + 3; i++) {
        await mkdir(path.join(tempDir, `dir-${String(i).padStart(2, "0")}`));
      }

      const page0 = await scanDirectory(tempDir, 0);
      expect(isScanError(page0)).toBe(false);
      if (isScanError(page0)) return;

      expect(page0.entries).toHaveLength(MAX_ENTRIES_PER_PAGE);
      expect(page0.totalCount).toBe(MAX_ENTRIES_PER_PAGE + 3);

      const page1 = await scanDirectory(tempDir, 1);
      expect(isScanError(page1)).toBe(false);
      if (isScanError(page1)) return;

      expect(page1.entries).toHaveLength(3);
    });

    it("should clamp page number to last valid page when page exceeds total", async () => {
      await mkdir(path.join(tempDir, "alpha"));
      await mkdir(path.join(tempDir, "bravo"));

      const result = await scanDirectory(tempDir, 99);
      expect(isScanError(result)).toBe(false);
      if (isScanError(result)) return;

      // Only 2 entries → 1 page → page should be clamped to 0
      expect(result.page).toBe(0);
      expect(result.entries).toHaveLength(2);
    });

    it("should clamp negative page number to 0", async () => {
      await mkdir(path.join(tempDir, "alpha"));

      const result = await scanDirectory(tempDir, -5);
      expect(isScanError(result)).toBe(false);
      if (isScanError(result)) return;

      expect(result.page).toBe(0);
      expect(result.entries).toHaveLength(1);
    });

    it("should return clamped page in result for valid pagination", async () => {
      for (let i = 0; i < MAX_ENTRIES_PER_PAGE + 3; i++) {
        await mkdir(path.join(tempDir, `dir-${String(i).padStart(2, "0")}`));
      }

      const result = await scanDirectory(tempDir, 1);
      expect(isScanError(result)).toBe(false);
      if (isScanError(result)) return;

      expect(result.page).toBe(1);
      expect(result.entries).toHaveLength(3);
    });

    it("should return hasParent=true for non-root directories", async () => {
      const result = await scanDirectory(tempDir);
      expect(isScanError(result)).toBe(false);
      if (isScanError(result)) return;

      expect(result.hasParent).toBe(true);
      expect(result.parentPath).toBe(path.dirname(tempDir));
    });

    it("should return error for non-existent directory", async () => {
      const result = await scanDirectory(path.join(tempDir, "nonexistent"));
      expect(isScanError(result)).toBe(true);
      if (!isScanError(result)) return;

      expect(result.code).toBe("ENOENT");
    });

    it("should return empty entries for empty directory", async () => {
      const result = await scanDirectory(tempDir);
      expect(isScanError(result)).toBe(false);
      if (isScanError(result)) return;

      expect(result.entries).toHaveLength(0);
      expect(result.totalCount).toBe(0);
    });
  });

  describe("buildEntryLabel", () => {
    it("should format entry with folder emoji", () => {
      const entry = { name: "my-project", fullPath: "/home/user/my-project" };
      expect(buildEntryLabel(entry)).toBe("📁 my-project");
    });
  });

  describe("buildTreeHeader", () => {
    it("should show path and count for single page", () => {
      const header = buildTreeHeader("~/projects", 3, 0, 1);
      expect(header).toContain("~/projects");
      expect(header).toContain("3");
      expect(header).not.toContain("(");
    });

    it("should show page indicator for multiple pages", () => {
      const header = buildTreeHeader("~/projects", 15, 1, 2);
      expect(header).toContain("(2/2)");
    });

    it("should show empty message when no subfolders", () => {
      const header = buildTreeHeader("~/empty", 0, 0, 1);
      // Localized — English default contains the "No subfolders" emoji indicator
      expect(header).toContain("📭");
    });

    it("should use singular form for 1 subfolder", () => {
      const header = buildTreeHeader("~/one", 1, 0, 1);
      expect(header).toContain("1 subfolder");
    });

    it("should use plural form for multiple subfolders", () => {
      const header = buildTreeHeader("~/many", 5, 0, 1);
      expect(header).toContain("5 subfolders");
    });
  });

  describe("isScanError", () => {
    it("should return true for error results", () => {
      expect(isScanError({ error: "test", code: "ENOENT" })).toBe(true);
    });

    it("should return false for success results", () => {
      const result = {
        entries: [],
        totalCount: 0,
        page: 0,
        currentPath: "/tmp",
        displayPath: "/tmp",
        hasParent: true,
        parentPath: "/",
      };
      expect(isScanError(result)).toBe(false);
    });
  });
});

describe("project-root symlink escape", () => {
  let tempRoot: string;
  let projectDir: string;
  let outsideDir: string;

  beforeEach(async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), "file-browser-symlink-"));
    projectDir = path.join(tempRoot, "project");
    outsideDir = path.join(tempRoot, "outside");
    await mkdir(projectDir, { recursive: true });
    await mkdir(outsideDir, { recursive: true });
    await writeFile(path.join(outsideDir, "secret.txt"), "top secret");
    // Junctions need no privileges on Windows; plain dir links elsewhere.
    await symlink(outsideDir, path.join(projectDir, "link"), process.platform === "win32" ? "junction" : "dir");
    projectHolder.worktree = projectDir;
  });

  afterEach(async () => {
    projectHolder.worktree = null;
    await rm(tempRoot, { recursive: true, force: true });
  });

  it("refuses to browse through a symlink pointing outside the project", async () => {
    const linkPath = path.join(projectDir, "link");

    expect(await isWithinProjectRootSafe(linkPath)).toBe(false);

    const scan = await scanLsDirectory(linkPath);
    expect(scan).toEqual({ error: expect.any(String) });
  });

  it("refuses file details through a symlink pointing outside the project", async () => {
    const details = await getFileDetails(path.join(projectDir, "link", "secret.txt"));

    expect(details).toEqual({ error: expect.any(String) });
  });

  it("still browses real directories inside the project", async () => {
    const scan = await scanLsDirectory(projectDir);

    expect(scan).not.toEqual({ error: expect.any(String) });
  });
});
