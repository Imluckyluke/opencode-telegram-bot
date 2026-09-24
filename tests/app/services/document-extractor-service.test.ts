import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/utils/logger.js", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

const mockDocExtractor = vi.hoisted(() => ({
  apiUrl: "",
  apiKey: "",
}));

vi.mock("../../../src/config.js", () => ({
  config: {
    docExtractor: mockDocExtractor,
    telegram: { token: "test", allowedUserId: 0, proxyUrl: "" },
    opencode: {
      apiUrl: "http://localhost:4096",
      username: "opencode",
      password: "",
      model: { provider: "test", modelId: "test" },
    },
    server: { logLevel: "error" },
    bot: {
      sessionsListLimit: 10,
      projectsListLimit: 10,
      locale: "en",
    },
    files: { maxFileSizeKb: 100 },
  },
}));

import {
  isDocExtractorConfigured,
  extractDocument,
} from "../../../src/app/services/document-extractor-service.js";
import { defined } from "../../helpers/defined.js";

describe("isDocExtractorConfigured", () => {
  beforeEach(() => {
    mockDocExtractor.apiUrl = "";
    mockDocExtractor.apiKey = "";
  });

  it("returns false when apiUrl is empty", () => {
    expect(isDocExtractorConfigured()).toBe(false);
  });

  it("returns true when only apiUrl is set (apiKey optional)", () => {
    mockDocExtractor.apiUrl = "https://extractor.example.com/extract";
    expect(isDocExtractorConfigured()).toBe(true);
  });

  it("returns true when both apiUrl and apiKey are set", () => {
    mockDocExtractor.apiUrl = "https://extractor.example.com/extract";
    mockDocExtractor.apiKey = "sk-test-key";
    expect(isDocExtractorConfigured()).toBe(true);
  });
});

describe("extractDocument", () => {
  beforeEach(() => {
    mockDocExtractor.apiUrl = "https://extractor.example.com/extract";
    mockDocExtractor.apiKey = "sk-test-key";
    vi.restoreAllMocks();
  });

  it("throws when doc extractor is not configured", async () => {
    mockDocExtractor.apiUrl = "";

    const fileBuffer = Buffer.from("fake-document-data");
    await expect(extractDocument(fileBuffer, "application/pdf", "doc.pdf")).rejects.toThrow(
      "Document extractor is not configured",
    );
  });

  it("sends correct request and returns extracted text", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ text: "Extracted document content" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const fileBuffer = Buffer.from("fake-document-data");
    const result = await extractDocument(fileBuffer, "application/pdf", "doc.pdf");

    expect(result).toEqual({ text: "Extracted document content" });

    expect(fetchSpy).toHaveBeenCalledOnce();
    const call = defined(fetchSpy.mock.calls[0]);
    const [url, options] = call;
    expect(url).toBe("https://extractor.example.com/extract");
    expect(options?.method).toBe("POST");
    expect((options?.headers as Record<string, string>)["Authorization"]).toBe(
      "Bearer sk-test-key",
    );
    expect(options?.body).toBeInstanceOf(FormData);
  });

  it("includes mimeType in Blob constructor", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ text: "Content" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const fileBuffer = Buffer.from("fake-docx-data");
    await extractDocument(fileBuffer, "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "doc.docx");

    const formData = defined(fetchSpy.mock.calls[0]?.[1])?.body as FormData;
    const fileField = formData.get("file") as Blob;

    expect(fileField).toBeInstanceOf(Blob);
    expect(fileField.type).toBe("application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  });

  it("does not send Authorization header when apiKey is empty", async () => {
    mockDocExtractor.apiKey = "";

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ text: "Content" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const fileBuffer = Buffer.from("fake-document-data");
    await extractDocument(fileBuffer, "application/pdf", "doc.pdf");

    const headers = defined(fetchSpy.mock.calls[0]?.[1])?.headers as Record<string, string>;
    expect(headers["Authorization"]).toBeUndefined();
  });

  it("throws on non-OK HTTP response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("Server error", {
        status: 500,
        statusText: "Internal Server Error",
      }),
    );

    const fileBuffer = Buffer.from("fake-document-data");
    await expect(extractDocument(fileBuffer, "application/pdf", "doc.pdf")).rejects.toThrow(
      "Document extractor API returned HTTP 500: Server error",
    );
  });

  it("throws when response has no text field", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ status: "ok" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const fileBuffer = Buffer.from("fake-document-data");
    await expect(extractDocument(fileBuffer, "application/pdf", "doc.pdf")).rejects.toThrow(
      "Document extractor API response does not contain a text field",
    );
  });

  it.each([
    ["content", { content: "from content field" }, "from content field"],
    ["markdown", { markdown: "# from markdown field" }, "# from markdown field"],
    ["data", { data: "from data field" }, "from data field"],
    ["bare JSON string", JSON.stringify("bare extracted text"), "bare extracted text"],
  ])("negotiates alternate response shape %s", async (_label, body, expected) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(typeof body === "string" ? body : JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const result = await extractDocument(Buffer.from("fake-document-data"), "application/pdf", "doc.pdf");

    expect(result).toEqual({ text: expected });
  });

  it("accepts a text/plain body as raw extracted text", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("plain extracted text", {
        status: 200,
        headers: { "Content-Type": "text/plain" },
      }),
    );

    const result = await extractDocument(Buffer.from("fake-document-data"), "application/pdf", "doc.pdf");

    expect(result).toEqual({ text: "plain extracted text" });
  });

  it("rejects a non-JSON error page instead of stuffing it into the prompt", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("<html><body>proxy error</body></html>", {
        status: 200,
        headers: { "Content-Type": "text/html" },
      }),
    );

    await expect(extractDocument(Buffer.from("fake"), "application/pdf", "doc.pdf")).rejects.toThrow(
      "does not contain a text field",
    );
  });

  it("throws when extracted text exceeds the char budget", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ text: "x".repeat(200 * 1024) }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await expect(extractDocument(Buffer.from("fake"), "application/pdf", "doc.pdf")).rejects.toThrow(
      /too much/,
    );
  });

  it("throws on timeout", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(
      new DOMException("The operation was aborted", "AbortError"),
    );

    const fileBuffer = Buffer.from("fake-document-data");
    await expect(extractDocument(fileBuffer, "application/pdf", "doc.pdf")).rejects.toThrow(
      "Document extractor request timed out",
    );
  });
});
