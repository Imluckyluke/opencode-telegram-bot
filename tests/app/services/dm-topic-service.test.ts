import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  getSessionTopicId: vi.fn(),
  setSessionTopicId: vi.fn(),
  getSessionTopicMap: vi.fn((): Record<string, number> => ({})),
  clearSessionTopicId: vi.fn(),
}));

vi.mock("../../../src/app/stores/settings-store.js", () => ({
  getSessionTopicId: mocked.getSessionTopicId,
  setSessionTopicId: mocked.setSessionTopicId,
  getSessionTopicMap: mocked.getSessionTopicMap,
  clearSessionTopicId: mocked.clearSessionTopicId,
}));

async function loadService() {
  vi.resetModules();
  return import("../../../src/app/services/dm-topic-service.js");
}

function stubBaseEnv() {
  vi.stubEnv("TELEGRAM_BOT_TOKEN", "test-token");
  vi.stubEnv("TELEGRAM_ALLOWED_USER_ID", "123");
  vi.stubEnv("OPENCODE_MODEL_PROVIDER", "test-provider");
  vi.stubEnv("OPENCODE_MODEL_ID", "test-model");
  vi.stubEnv("DM_TOPICS_ENABLED", "");
}

function createApi() {
  return {
    createForumTopic: vi.fn().mockResolvedValue({ message_thread_id: 7, name: "Session" }),
  };
}

describe("dm-topic-service", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    stubBaseEnv();
    mocked.getSessionTopicId.mockReset().mockReturnValue(null);
    mocked.setSessionTopicId.mockReset();
    mocked.getSessionTopicMap.mockReset().mockReturnValue({});
    mocked.clearSessionTopicId.mockReset();
  });

  it("extracts only real topic threads", async () => {
    const service = await loadService();

    expect(service.extractInboundThreadId(undefined)).toBeNull();
    expect(service.extractInboundThreadId({})).toBeNull();
    expect(service.extractInboundThreadId({ message_thread_id: 1 })).toBeNull();
    expect(service.extractInboundThreadId({ message_thread_id: 42 })).toBe(42);
  });

  it("returns the bound topic without creating a new one", async () => {
    const service = await loadService();
    mocked.getSessionTopicId.mockReturnValue(9);
    const api = createApi();

    const threadId = await service.ensureSessionTopic(
      api as never,
      123,
      { id: "session-1", title: "Session", directory: "/repo" },
    );

    expect(threadId).toBe(9);
    expect(api.createForumTopic).not.toHaveBeenCalled();
  });

  it("creates and persists a topic on first use", async () => {
    const service = await loadService();
    const api = createApi();

    const threadId = await service.ensureSessionTopic(
      api as never,
      123,
      { id: "session-1", title: "My feature", directory: "/repo" },
    );

    expect(threadId).toBe(7);
    expect(api.createForumTopic).toHaveBeenCalledWith(123, "My feature");
    expect(mocked.setSessionTopicId).toHaveBeenCalledWith("session-1", 7);
  });

  it("falls back to the main chat when creation fails", async () => {
    const service = await loadService();
    const api = createApi();
    api.createForumTopic.mockRejectedValueOnce(new Error("Bad Request: can't create topic"));

    const threadId = await service.ensureSessionTopic(
      api as never,
      123,
      { id: "session-1", title: "Session", directory: "/repo" },
    );

    expect(threadId).toBeNull();
    expect(mocked.setSessionTopicId).not.toHaveBeenCalled();
  });

  it("stays in the main chat when DM topics are disabled", async () => {
    vi.stubEnv("DM_TOPICS_ENABLED", "off");
    const service = await loadService();
    const api = createApi();

    expect(service.getBoundTopicId("session-1")).toBeNull();
    const threadId = await service.ensureSessionTopic(
      api as never,
      123,
      { id: "session-1", title: "Session", directory: "/repo" },
    );

    expect(threadId).toBeNull();
    expect(api.createForumTopic).not.toHaveBeenCalled();
  });

  it("adopts unowned threads but never steals bound ones", async () => {
    const service = await loadService();

    service.adoptInboundThread("session-1", 11);
    expect(mocked.setSessionTopicId).toHaveBeenCalledWith("session-1", 11);

    mocked.getSessionTopicMap.mockReturnValue({ "session-9": 12 });
    service.adoptInboundThread("session-1", 12);
    expect(mocked.setSessionTopicId).toHaveBeenCalledTimes(1);
  });
});
