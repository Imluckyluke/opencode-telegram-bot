import { describe, expect, it } from "vitest";
import { HealthServer } from "../../../src/app/services/health-server-service.js";

describe("app/services/health-server-service", () => {
  it("does nothing when the port is 0 (disabled)", async () => {
    const server = new HealthServer();
    await server.start(0, "test");
    await server.stop();
  });

  it("answers /health/live with 200 on a real port", async () => {
    const server = new HealthServer();
    // Find a free port via a throwaway server.
    const net = await import("node:net");
    const port = await new Promise<number>((resolve) => {
      const s = net.createServer();
      s.listen(0, "127.0.0.1", () => {
        const address = s.address();
        const p = typeof address === "object" && address ? address.port : 0;
        s.close(() => resolve(p));
      });
    });
    await server.start(port, "phase1-test");
    const res = await fetch(`http://127.0.0.1:${port}/health/live`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; version: string };
    expect(body.status).toBe("healthy");
    expect(body.version).toBe("phase1-test");
    const notFound = await fetch(`http://127.0.0.1:${port}/nope`);
    expect(notFound.status).toBe(404);
    await server.stop();
  });
});
