import { afterEach, describe, expect, it } from "vitest";
import { formatSessionTitle } from "../../../src/app/formatters/session-title-formatter.js";
import { resetRuntimeLocale, setRuntimeLocale } from "../../../src/i18n/index.js";

describe("app/formatters/session-title-formatter", () => {
  afterEach(() => {
    resetRuntimeLocale();
  });

  it("shows a session OpenCode has not named yet under the dashboard's name", () => {
    setRuntimeLocale("en");
    expect(formatSessionTitle("")).toBe("new session");

    setRuntimeLocale("ru");
    expect(formatSessionTitle("")).toBe("новая сессия");
  });

  it("keeps a title OpenCode set as it is", () => {
    setRuntimeLocale("en");
    expect(formatSessionTitle("Greeting message")).toBe("Greeting message");
    expect(formatSessionTitle("New session - 2026-09-27T18:58:25.597Z")).toBe(
      "New session - 2026-09-27T18:58:25.597Z",
    );
    expect(formatSessionTitle("   ")).toBe("   ");
  });
});
