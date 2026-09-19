import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const PROXY_SCRIPT = resolve(__dirname, "../../e2e/fault-proxy.mjs");
const TOKEN = "123456:TEST-token-value";

interface RecordedRequest {
  method: string;
  url: string;
  body: Buffer;
}

interface Upstream {
  url: string;
  requests: RecordedRequest[];
  firstChunk: Promise<Buffer>;
  close: () => Promise<void>;
}

interface CallResult {
  status: number;
  body: string;
}

async function startUpstream(): Promise<Upstream> {
  const requests: RecordedRequest[] = [];
  let resolveFirstChunk: (chunk: Buffer) => void = () => {};
  const firstChunk = new Promise<Buffer>((resolveChunk) => {
    resolveFirstChunk = resolveChunk;
  });

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      if (chunks.length === 0) resolveFirstChunk(chunk);
      chunks.push(chunk);
    });
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      requests.push({ method: req.method ?? "", url: req.url ?? "", body });

      if (req.url?.startsWith("/file/")) {
        res.writeHead(200, { "content-type": "application/octet-stream" });
        res.end(Buffer.from([0, 1, 2, 3, 254, 255]));
        return;
      }
      const answer = JSON.stringify({ ok: true, result: { echo: body.toString("utf8") } });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(answer);
    });
  });

  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    firstChunk,
    close: () =>
      new Promise((resolveClose) => {
        server.closeAllConnections();
        server.close(() => resolveClose());
      }),
  };
}

async function startProxy(
  upstreamUrl: string,
  stateDir: string,
): Promise<{ port: number; child: ChildProcessWithoutNullStreams }> {
  const child = spawn(process.execPath, [
    PROXY_SCRIPT,
    "--port",
    "0",
    "--upstream",
    upstreamUrl,
    "--state-dir",
    stateDir,
  ]);

  const port = await new Promise<number>((resolvePort, rejectPort) => {
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
      const match = output.match(/listening on http:\/\/127\.0\.0\.1:(\d+)/);
      if (match) resolvePort(Number(match[1]));
    });
    child.stderr.on("data", (chunk: Buffer) => rejectPort(new Error(chunk.toString("utf8"))));
    child.on("exit", (code) => rejectPort(new Error(`proxy exited with ${code}`)));
  });

  return { port, child };
}

function request(
  port: number,
  path: string,
  options: { method?: string; body?: string | Buffer | undefined; contentType?: string } = {},
): Promise<CallResult> {
  return new Promise((resolveCall, rejectCall) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path,
        method: options.method ?? "POST",
        agent: false,
        headers: options.contentType ? { "content-type": options.contentType } : {},
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () =>
          resolveCall({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("latin1"),
          }),
        );
        res.on("error", rejectCall);
      },
    );
    req.on("error", rejectCall);
    req.end(options.body);
  });
}

function callBot(port: number, method: string, payload: object = {}): Promise<CallResult> {
  return request(port, `/bot${TOKEN}/${method}`, {
    body: JSON.stringify(payload),
    contentType: "application/json",
  });
}

async function control(
  port: number,
  method: string,
  route: string,
  body?: object,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const result = await request(port, `/__fault${route}`, {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
    contentType: "application/json",
  });
  return { status: result.status, json: JSON.parse(result.body) as Record<string, unknown> };
}

describe("e2e fault proxy", () => {
  let upstream: Upstream;
  let proxy: { port: number; child: ChildProcessWithoutNullStreams };
  let stateDir: string;

  beforeEach(async () => {
    stateDir = mkdtempSync(join(tmpdir(), "fault-proxy-"));
    upstream = await startUpstream();
    proxy = await startProxy(upstream.url, stateDir);
  });

  afterEach(async () => {
    proxy.child.kill();
    await upstream.close();
    rmSync(stateDir, { recursive: true, force: true });
  });

  function readCallLog(): Array<Record<string, unknown>> {
    const file = readdirSync(stateDir).find((name) => name.endsWith(".jsonl"));
    if (!file) return [];
    return readFileSync(join(stateDir, file), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  }

  it("forwards JSON calls unchanged when no fault is active", async () => {
    const result = await callBot(proxy.port, "sendMessage", { chat_id: 1, text: "hello" });

    expect(result.status).toBe(200);
    expect(JSON.parse(result.body)).toEqual({
      ok: true,
      result: { echo: JSON.stringify({ chat_id: 1, text: "hello" }) },
    });
    expect(upstream.requests).toHaveLength(1);
    expect(upstream.requests[0]?.url).toBe(`/bot${TOKEN}/sendMessage`);
  });

  it("forwards multipart uploads and file downloads byte-exact", async () => {
    const multipart = Buffer.concat([
      Buffer.from('--b\r\nContent-Disposition: form-data; name="photo"\r\n\r\n'),
      Buffer.from([0, 10, 13, 255, 128]),
      Buffer.from("\r\n--b--\r\n"),
    ]);
    await request(proxy.port, `/bot${TOKEN}/sendPhoto`, {
      body: multipart,
      contentType: "multipart/form-data; boundary=b",
    });
    const download = await request(proxy.port, `/file/bot${TOKEN}/photos/file_1.jpg`, {
      method: "GET",
    });

    expect(upstream.requests[0]?.body.equals(multipart)).toBe(true);
    expect(Buffer.from(download.body, "latin1").equals(Buffer.from([0, 1, 2, 3, 254, 255]))).toBe(
      true,
    );
    expect(upstream.requests[1]?.url).toBe(`/file/bot${TOKEN}/photos/file_1.jpg`);
  });

  it("streams a multipart upload before the client has sent all of it", async () => {
    const req = http.request({
      host: "127.0.0.1",
      port: proxy.port,
      path: `/bot${TOKEN}/sendDocument`,
      method: "POST",
      agent: false,
      headers: { "content-type": "multipart/form-data; boundary=b" },
    });
    req.on("error", () => {});
    req.write("first-part");

    const firstChunk = await upstream.firstChunk;

    expect(firstChunk.toString("utf8")).toBe("first-part");
    req.end("second-part");
  });

  it("drops the connection without reaching upstream", async () => {
    await control(proxy.port, "POST", "/rules", { methods: "sendMessage", action: "drop" });

    await expect(callBot(proxy.port, "sendMessage")).rejects.toThrow();
    expect(upstream.requests).toHaveLength(0);
    expect(readCallLog()[0]).toMatchObject({
      method: "sendMessage",
      reachedUpstream: false,
      injected: { rule: "r1", action: "drop" },
    });
  });

  it("delivers to upstream and then drops the answer", async () => {
    await control(proxy.port, "POST", "/scenarios/no-duplicate");

    await expect(callBot(proxy.port, "sendMessage", { text: "once" })).rejects.toThrow();
    const second = await callBot(proxy.port, "sendMessage", { text: "twice" });

    expect(upstream.requests).toHaveLength(2);
    expect(second.status).toBe(200);
    expect(readCallLog()[0]).toMatchObject({
      reachedUpstream: true,
      status: 200,
      injected: { action: "deliver-then-drop" },
    });
  });

  it("answers with a Bot API error body", async () => {
    await control(proxy.port, "POST", "/rules", {
      methods: "editMessageText",
      action: { type: "error", status: 429, retryAfter: 7 },
    });
    await control(proxy.port, "POST", "/rules", {
      methods: "sendMessage",
      action: { type: "error", status: 400, description: "Bad Request: can't parse entities" },
    });

    const limited = await callBot(proxy.port, "editMessageText");
    const badRequest = await callBot(proxy.port, "sendMessage");

    expect(limited.status).toBe(429);
    expect(JSON.parse(limited.body)).toEqual({
      ok: false,
      error_code: 429,
      description: "Too Many Requests",
      parameters: { retry_after: 7 },
    });
    expect(JSON.parse(badRequest.body)).toMatchObject({
      error_code: 400,
      description: "Bad Request: can't parse entities",
    });
    expect(upstream.requests).toHaveLength(0);
  });

  it("hangs and then drops, and adds latency before forwarding", async () => {
    await control(proxy.port, "POST", "/rules", {
      methods: "getMe",
      action: { type: "hang", seconds: 0.3 },
    });
    await control(proxy.port, "POST", "/rules", {
      methods: "getChat",
      action: { type: "latency", ms: 300 },
    });

    const hangStart = Date.now();
    await expect(callBot(proxy.port, "getMe")).rejects.toThrow();
    const hangElapsed = Date.now() - hangStart;
    const latencyStart = Date.now();
    const delayed = await callBot(proxy.port, "getChat");
    const latencyElapsed = Date.now() - latencyStart;

    expect(hangElapsed).toBeGreaterThanOrEqual(250);
    expect(latencyElapsed).toBeGreaterThanOrEqual(250);
    expect(delayed.status).toBe(200);
    expect(upstream.requests.map((item) => item.url)).toEqual([`/bot${TOKEN}/getChat`]);
  });

  it("selects calls by number, payload and method list", async () => {
    await control(proxy.port, "POST", "/rules", {
      methods: "sendMessage",
      when: { every: 2 },
      action: { type: "error", status: 500 },
    });
    await control(proxy.port, "POST", "/rules", {
      methods: ["editMessageText", "deleteMessage"],
      when: { from: 3 },
      action: { type: "error", status: 502 },
    });
    await control(proxy.port, "POST", "/rules", {
      methods: "sendChatAction",
      payloadContains: "upload_photo",
      action: { type: "error", status: 503 },
    });
    await control(proxy.port, "POST", "/rules", {
      methods: "answerCallbackQuery",
      when: "once",
      action: { type: "error", status: 504 },
    });

    const statuses: number[] = [];
    for (let index = 0; index < 4; index++) {
      statuses.push((await callBot(proxy.port, "sendMessage")).status);
    }
    statuses.push((await callBot(proxy.port, "editMessageText")).status);
    statuses.push((await callBot(proxy.port, "deleteMessage")).status);
    statuses.push((await callBot(proxy.port, "editMessageText")).status);
    statuses.push((await callBot(proxy.port, "sendChatAction", { action: "typing" })).status);
    statuses.push((await callBot(proxy.port, "sendChatAction", { action: "upload_photo" })).status);
    statuses.push((await callBot(proxy.port, "answerCallbackQuery")).status);
    statuses.push((await callBot(proxy.port, "answerCallbackQuery")).status);

    expect(statuses).toEqual([200, 500, 200, 500, 200, 200, 502, 200, 503, 504, 200]);
  });

  it("expires a rule after its duration and clears rules on request", async () => {
    await control(proxy.port, "POST", "/rules", {
      methods: "getMe",
      durationSeconds: 0.3,
      action: { type: "error", status: 500 },
    });
    await control(proxy.port, "POST", "/rules", {
      methods: "getChat",
      action: { type: "error", status: 500 },
    });

    expect((await callBot(proxy.port, "getMe")).status).toBe(500);
    await new Promise((resolveWait) => setTimeout(resolveWait, 400));
    expect((await callBot(proxy.port, "getMe")).status).toBe(200);

    await control(proxy.port, "DELETE", "/rules");
    expect((await callBot(proxy.port, "getChat")).status).toBe(200);
    expect((await control(proxy.port, "GET", "/rules")).json.rules).toEqual([]);
  });

  it("applies named scenarios and rejects unknown ones and invalid rules", async () => {
    const blackout = await control(proxy.port, "POST", "/scenarios/blackout", {
      durationSeconds: 120,
    });
    await expect(callBot(proxy.port, "getUpdates")).rejects.toThrow();
    await expect(
      request(proxy.port, `/file/bot${TOKEN}/voice/file_2.oga`, { method: "GET" }),
    ).rejects.toThrow();
    await control(proxy.port, "DELETE", "/rules");
    await control(proxy.port, "POST", "/scenarios/drop-send");
    const unknown = await control(proxy.port, "POST", "/scenarios/nope");
    const invalid = await control(proxy.port, "POST", "/rules", { action: { type: "explode" } });

    expect(blackout.status).toBe(200);
    await expect(callBot(proxy.port, "sendRichMessage")).rejects.toThrow();
    expect((await callBot(proxy.port, "getUpdates")).status).toBe(200);
    expect(unknown.status).toBe(404);
    expect(invalid.status).toBe(400);
  });

  it("counts calls per method and resets the counters", async () => {
    await control(proxy.port, "POST", "/rules", {
      methods: "sendMessage",
      when: "once",
      action: { type: "error", status: 500 },
    });
    await callBot(proxy.port, "sendMessage");
    await callBot(proxy.port, "sendMessage");

    const stats = await control(proxy.port, "GET", "/stats");
    await control(proxy.port, "DELETE", "/stats");
    const afterReset = await control(proxy.port, "GET", "/stats");

    expect(stats.json.stats).toEqual({
      sendMessage: { calls: 2, injected: 1, reachedUpstream: 1 },
    });
    expect(afterReset.json.stats).toEqual({});
  });

  it("never exposes the bot token in the call log or control answers", async () => {
    await callBot(proxy.port, "sendMessage", { text: "hi" });
    await request(proxy.port, `/file/bot${TOKEN}/photos/file_1.jpg`, { method: "GET" });

    const state = await request(proxy.port, "/__fault/state", { method: "GET" });
    const logText = readCallLog()
      .map((entry) => JSON.stringify(entry))
      .join("\n");

    expect(logText).not.toContain(TOKEN);
    expect(logText).toContain("/bot<token>/sendMessage");
    expect(state.body).not.toContain(TOKEN);
  });
});
