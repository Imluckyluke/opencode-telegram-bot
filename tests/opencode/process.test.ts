import { describe, expect, it, vi, beforeEach } from "vitest";

import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";

import {
  createOpencodeServeSpawnCommand,
  findUnixListeningPidInSs,
  findWindowsListeningPidInNetstat,
  resolveLocalOpencodeTarget,
  startLocalOpencodeServer,
  __resetTrackedServersForTests,
} from "../../src/opencode/process.js";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: spawnMock,
  };
});

describe("opencode/process", () => {
  it("matches the exact local port on Windows netstat output", async () => {
    const stdout = [
      "  TCP    127.0.0.1:40960      0.0.0.0:0      LISTENING       1111",
      "  TCP    127.0.0.1:4096       0.0.0.0:0      LISTENING       2222",
    ].join("\r\n");

    expect(findWindowsListeningPidInNetstat(stdout, 4096)).toBe(2222);
  });

  it("matches the exact local port in ss fallback output", async () => {
    const stdout = [
      'LISTEN 0 128 127.0.0.1:40960 0.0.0.0:* users:(("node",pid=1111,fd=17))',
      'LISTEN 0 128 127.0.0.1:4096 0.0.0.0:* users:(("opencode",pid=2222,fd=18))',
    ].join("\n");

    expect(findUnixListeningPidInSs(stdout, 4096)).toBe(2222);
  });

  it("builds opencode serve command with the configured local port", () => {
    const command = createOpencodeServeSpawnCommand({ host: "localhost", port: 4987 });

    if (process.platform === "win32") {
      expect(command.windowsHide).toBe(true);

      // If we claim to spawn opencode.exe directly, it must be a real absolute path.
      // Otherwise, spawn() will likely fail with ENOENT on default npm installs where
      // only opencode.cmd is on PATH.
      if (command.command.toLowerCase() === "cmd.exe") {
        expect(command.args).toEqual(["/c", "opencode", "serve", "--port", "4987"]);
      } else {
        expect(path.isAbsolute(command.command)).toBe(true);
        expect(command.command.toLowerCase().endsWith("\\opencode.exe")).toBe(true);
        expect(command.args).toEqual(["serve", "--port", "4987"]);
      }
      return;
    }

    expect(command).toEqual({
      command: "opencode",
      args: ["serve", "--port", "4987"],
      windowsHide: false,
    });
  });

  it("falls back to cmd.exe on Windows when opencode.exe cannot be resolved", () => {
    if (process.platform !== "win32") {
      return;
    }

    const originalPath = process.env.PATH;

    try {
      process.env.PATH = "";

      const command = createOpencodeServeSpawnCommand({ host: "localhost", port: 4987 });
      expect(command).toEqual({
        command: "cmd.exe",
        args: ["/c", "opencode", "serve", "--port", "4987"],
        windowsHide: true,
      });
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it("resolves opencode.exe directly from PATH when no .cmd shim exists", () => {
    if (process.platform !== "win32") {
      return;
    }

    const originalPath = process.env.PATH;
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-telegram-bot-"));
    const binDir = path.join(tempRoot, "bin");
    const exePath = path.join(binDir, "opencode.exe");

    try {
      fs.mkdirSync(binDir, { recursive: true });
      fs.writeFileSync(exePath, "", "utf8");

      // Isolate PATH to only the temp dir — no npm .cmd shim on PATH
      process.env.PATH = binDir;

      const command = createOpencodeServeSpawnCommand({ host: "localhost", port: 4987 });
      expect(command).toEqual({
        command: exePath,
        args: ["serve", "--port", "4987"],
        windowsHide: true,
      });
    } finally {
      process.env.PATH = originalPath;
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("uses resolved opencode.exe on Windows when opencode.cmd is on PATH and exe exists", () => {
    if (process.platform !== "win32") {
      return;
    }

    const originalPath = process.env.PATH;
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-telegram-bot-"));
    const binDir = path.join(tempRoot, "bin");
    const exePath = path.join(binDir, "node_modules", "opencode-ai", "bin", "opencode.exe");
    const cmdPath = path.join(binDir, "opencode.cmd");

    try {
      fs.mkdirSync(path.dirname(exePath), { recursive: true });
      fs.writeFileSync(exePath, "", "utf8");
      fs.writeFileSync(cmdPath, "@echo off\r\nexit /b 0\r\n", "utf8");

      process.env.PATH = [binDir, originalPath].filter(Boolean).join(path.delimiter);

      const command = createOpencodeServeSpawnCommand({ host: "localhost", port: 4987 });
      expect(command).toEqual({
        command: exePath,
        args: ["serve", "--port", "4987"],
        windowsHide: true,
      });
    } finally {
      process.env.PATH = originalPath;
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  describe("resolveLocalOpencodeTarget", () => {
    it("accepts valid local ports", () => {
      expect(resolveLocalOpencodeTarget("http://localhost:4096")).toEqual({
        host: "localhost",
        port: 4096,
      });
    });

    it("rejects out-of-range ports", () => {
      expect(resolveLocalOpencodeTarget("http://localhost:99999")).toBeNull();
      expect(resolveLocalOpencodeTarget("http://localhost:0")).toBeNull();
    });

    it("rejects non-local hosts", () => {
      expect(resolveLocalOpencodeTarget("http://example.com:4096")).toBeNull();
    });
  });

  describe("startLocalOpencodeServer", () => {
    beforeEach(() => {
      spawnMock.mockReset();
      __resetTrackedServersForTests();
    });

    function fakeChild(pid: number | undefined) {
      return { pid, once: vi.fn(), unref: vi.fn() };
    }

    it("reuses the tracked child while it is still alive", () => {
      spawnMock.mockReturnValue(fakeChild(process.pid));

      const first = startLocalOpencodeServer({ host: "localhost", port: 4096 });
      const second = startLocalOpencodeServer({ host: "localhost", port: 4096 });

      expect(spawnMock).toHaveBeenCalledTimes(1);
      expect(second).toBe(first);
    });

    it("spawns again after the tracked child died", () => {
      spawnMock.mockReturnValueOnce(fakeChild(999999999)).mockReturnValue(fakeChild(process.pid));

      startLocalOpencodeServer({ host: "localhost", port: 4096 });
      const second = startLocalOpencodeServer({ host: "localhost", port: 4096 });

      expect(spawnMock).toHaveBeenCalledTimes(2);
      expect(second).not.toBeUndefined();
    });

    it("tracks ports independently", () => {
      spawnMock.mockReturnValue(fakeChild(process.pid));

      startLocalOpencodeServer({ host: "localhost", port: 4096 });
      startLocalOpencodeServer({ host: "localhost", port: 4097 });

      expect(spawnMock).toHaveBeenCalledTimes(2);
    });
  });
});
