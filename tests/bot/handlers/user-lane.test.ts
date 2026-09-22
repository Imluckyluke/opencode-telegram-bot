import { describe, expect, it } from "vitest";
import type { Context } from "grammy";
import { isUserLaneContent } from "../../../src/bot/handlers/user-lane.js";

function laneContext(message: unknown): Context {
  return {
    from: { id: 222 },
    chat: { id: 222 },
    message,
  } as unknown as Context;
}

describe("bot/handlers/user-lane isUserLaneContent", () => {
  it("accepts plain text prompts", () => {
    expect(isUserLaneContent(laneContext({ text: "fix it" }))).toBe(true);
  });

  it("rejects commands", () => {
    expect(isUserLaneContent(laneContext({ text: "/status" }))).toBe(false);
    expect(isUserLaneContent(laneContext({ text: "  /new" }))).toBe(false);
  });

  it("accepts voice, photos, documents, and video", () => {
    expect(isUserLaneContent(laneContext({ voice: { file_id: "v" } }))).toBe(true);
    expect(isUserLaneContent(laneContext({ audio: { file_id: "a" } }))).toBe(true);
    expect(isUserLaneContent(laneContext({ photo: [{ file_id: "p" }] }))).toBe(true);
    expect(isUserLaneContent(laneContext({ document: { file_id: "d" } }))).toBe(true);
    expect(isUserLaneContent(laneContext({ video: { file_id: "v" } }))).toBe(true);
    expect(isUserLaneContent(laneContext({ animation: { file_id: "g" } }))).toBe(true);
  });

  it("prefers attached media over command-like captions", () => {
    expect(isUserLaneContent(laneContext({ caption: "/status", photo: [{ file_id: "p" }] }))).toBe(
      true,
    );
    expect(isUserLaneContent(laneContext({}))).toBe(false);
    expect(isUserLaneContent({} as Context)).toBe(false);
  });

  it("accepts captions as content", () => {
    expect(isUserLaneContent(laneContext({ caption: "what is this", photo: [{ file_id: "p" }] }))).toBe(
      true,
    );
  });
});
