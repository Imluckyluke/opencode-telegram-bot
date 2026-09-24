import { describe, expect, it } from "vitest";
import { redactUrlCredentials } from "../../src/utils/url-redact.js";

describe("utils/url-redact", () => {
  it("redacts user and password, keeping host and path", () => {
    expect(redactUrlCredentials("https://user:pass@host:8443/path")).toBe(
      "https://***@host:8443/path",
    );
  });

  it("redacts socks proxy credentials", () => {
    expect(redactUrlCredentials("socks5://u:p@127.0.0.1:1080")).toBe("socks5://***@127.0.0.1:1080");
  });

  it("leaves urls without userinfo unchanged", () => {
    expect(redactUrlCredentials("http://localhost:4096")).toBe("http://localhost:4096");
    expect(redactUrlCredentials("https://api.telegram.org/bot123/abc")).toBe(
      "https://api.telegram.org/bot123/abc",
    );
  });

  it("does not eat an at-sign in the path", () => {
    expect(redactUrlCredentials("https://host/path@file")).toBe("https://host/path@file");
  });
});
