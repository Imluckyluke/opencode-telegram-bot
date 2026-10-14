import http from "node:http";
import { logger } from "../../utils/logger.js";

const HEALTH_HOST = "127.0.0.1";
const CLOSE_CONNECTIONS_TIMEOUT_MS = 2000;

interface HealthPayload {
  status: "healthy";
  version: string;
  uptimeSeconds: number;
  timestamp: string;
}

function sendJson(res: http.ServerResponse, statusCode: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  res.end(body);
}

/**
 * Loopback HTTP endpoint for Docker and orchestrators: liveness and a basic
 * health payload. Phase 1 is intentionally liveness-only (no OpenCode coupling,
 * which arrives with server-health in Phase 2). A failed listen is logged and
 * the bot runs on.
 */
export class HealthServer {
  private server: http.Server | null = null;
  private startTimeMs: number | null = null;
  private version = "unknown";

  async start(port: number, version: string): Promise<void> {
    if (port === 0) {
      logger.info("[Health] Health server disabled (BOT_HEALTH_PORT is not set or 0)");
      return;
    }
    if (this.server) {
      logger.warn("[Health] Health server already running");
      return;
    }

    this.version = version;
    this.startTimeMs = Date.now();
    const server = http.createServer((req, res) => {
      void this.handleRequest(req, res);
    });
    this.server = server;

    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, HEALTH_HOST, () => {
          server.off("error", reject);
          resolve();
        });
      });
    } catch (error) {
      this.server = null;
      this.startTimeMs = null;
      logger.warn(
        `[Health] Health server could not listen on ${HEALTH_HOST}:${port}; continuing without it`,
        error,
      );
      return;
    }

    server.on("error", (error) => {
      logger.error("[Health] Health server error", error);
    });
    logger.info(
      `[Health] Health server listening on ${HEALTH_HOST}:${port} (/health, /health/live, /health/ready)`,
    );
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (!server) {
      return;
    }

    this.server = null;
    this.startTimeMs = null;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      setTimeout(() => {
        server.closeAllConnections();
        resolve();
      }, CLOSE_CONNECTIONS_TIMEOUT_MS).unref();
    });
    logger.info("[Health] Health server stopped");
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (req.method !== "GET") {
      sendJson(res, 405, { error: "Method not allowed" });
      return;
    }

    // Split by hand: new URL() throws on targets like "//".
    const path = (req.url ?? "/").split("?")[0];

    if (path === "/health/live" || path === "/health/ready" || path === "/health") {
      sendJson(res, 200, this.buildHealthPayload());
      return;
    }

    sendJson(res, 404, { error: "Not found", path });
  }

  private buildHealthPayload(): HealthPayload {
    return {
      status: "healthy",
      version: this.version,
      uptimeSeconds: this.getUptimeSeconds(),
      timestamp: new Date().toISOString(),
    };
  }

  private getUptimeSeconds(): number {
    if (this.startTimeMs === null) {
      return 0;
    }
    return Math.floor((Date.now() - this.startTimeMs) / 1000);
  }
}
