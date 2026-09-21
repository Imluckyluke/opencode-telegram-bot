import { describe, expect, it } from "vitest";
import {
  buildInlineResults,
  consumePendingInlineQuery,
  extractGuestDocument,
  extractGuestPhoto,
  extractGuestReplyText,
  extractGuestVideo,
  extractGuestVoice,
  guestVoiceFilename,
  INLINE_STATUS_RESULT_ID,
  stripBotMention,
  truncateInlineText,
} from "../../../src/bot/inline/inline-results.js";
import type { InlineSnapshot } from "../../../src/bot/inline/inline-results.js";

const snapshot: InlineSnapshot = {
  projectName: "/repo",
  sessionTitle: "Session",
  modelLabel: "openai/gpt-5",
  contextLine: "Context",
};

describe("bot/inline/inline-results", () => {
  it("always includes the status card", () => {
    const results = buildInlineResults("", snapshot, "TestBot");

    expect(results).toHaveLength(1);
    expect(results[0]?.id).toBe(INLINE_STATUS_RESULT_ID);
  });

  it("adds an ask action with a keyboard for in-place edits", () => {
    const results = buildInlineResults("fix the bug", snapshot, "TestBot");

    expect(results).toHaveLength(2);
    const askId = String(results[0]?.id);
    expect(askId).not.toBe(INLINE_STATUS_RESULT_ID);
    expect(results[0]?.reply_markup?.inline_keyboard[0]?.[0]?.url).toBe(
      "https://t.me/TestBot",
    );

    expect(consumePendingInlineQuery(askId)).toBe("fix the bug");
    expect(consumePendingInlineQuery(askId)).toBeNull();
  });

  it("omits the keyboard without a bot username", () => {
    const results = buildInlineResults("fix the bug", snapshot, null);

    expect(results[0]?.reply_markup).toBeUndefined();
  });

  it("rejects unknown result ids", () => {
    expect(consumePendingInlineQuery("ask_unknown")).toBeNull();
    expect(consumePendingInlineQuery(INLINE_STATUS_RESULT_ID)).toBeNull();
  });

  it("truncates long texts with an ellipsis", () => {
    expect(truncateInlineText("short")).toBe("short");
    const long = truncateInlineText("x".repeat(5000));
    expect(long.length).toBeLessThanOrEqual(4000);
    expect(long.endsWith("…")).toBe(true);
  });

  it("extracts the largest photo, preferring the message over the reply", () => {
    expect(extractGuestPhoto(undefined)).toBeNull();
    expect(extractGuestPhoto({})).toBeNull();
    expect(
      extractGuestPhoto({
        photo: [
          { file_id: "small", file_size: 100 },
          { file_id: "big", file_size: 900 },
        ],
      }),
    ).toEqual({ fileId: "big", fileSize: 900 });
    expect(
      extractGuestPhoto({
        reply_to_message: { photo: [{ file_id: "replied" }] },
      }),
    ).toEqual({ fileId: "replied", fileSize: undefined });
  });

  it("extracts documents and voice, preferring direct over replied", () => {
    expect(
      extractGuestDocument({ document: { file_id: "d1", mime_type: "application/pdf", file_name: "a.pdf" } }),
    ).toEqual({ fileId: "d1", fileSize: undefined, mime: "application/pdf", filename: "a.pdf" });
    expect(
      extractGuestDocument({ reply_to_message: { document: { file_id: "d2" } } }),
    ).toEqual({ fileId: "d2", fileSize: undefined, mime: undefined, filename: undefined });
    expect(extractGuestDocument({})).toBeNull();
    expect(
      extractGuestVoice({ voice: { file_id: "v1", mime_type: "audio/ogg" } }),
    ).toEqual({ fileId: "v1", fileSize: undefined, mime: "audio/ogg" });
    expect(
      extractGuestVoice({ reply_to_message: { audio: { file_id: "a1" } } }),
    ).toEqual({ fileId: "a1", fileSize: undefined, mime: undefined });
    expect(extractGuestVoice({})).toBeNull();
    expect(guestVoiceFilename("audio/mpeg")).toBe("voice.mp3");
    expect(guestVoiceFilename("audio/mp4")).toBe("voice.m4a");
    expect(guestVoiceFilename(undefined)).toBe("voice.ogg");
  });

  it("extracts GIF/animation and video, direct or replied", () => {
    expect(
      extractGuestVideo({ animation: { file_id: "g1", mime_type: "video/mp4" } }),
    ).toEqual({ fileId: "g1", fileSize: undefined, mime: "video/mp4", filename: "animation.mp4" });
    expect(
      extractGuestVideo({ reply_to_message: { video: { file_id: "v1" } } }),
    ).toEqual({ fileId: "v1", fileSize: undefined, mime: "video/mp4", filename: "video.mp4" });
    expect(extractGuestVideo({})).toBeNull();
  });

  it("extracts reply text and strips bot mentions", () => {
    expect(extractGuestReplyText(undefined)).toBeNull();
    expect(extractGuestReplyText({})).toBeNull();
    expect(
      extractGuestReplyText({ reply_to_message: { text: "  original question  " } }),
    ).toBe("original question");
    expect(
      extractGuestReplyText({ reply_to_message: { caption: "cap" } }),
    ).toBe("cap");
    expect(stripBotMention("@ImLuckylukebot این چیه؟", "ImLuckylukebot")).toBe("این چیه؟");
    expect(stripBotMention("hi @imluckylukebot there", "ImLuckylukebot")).toBe("hi there");
    expect(stripBotMention("untouched", null)).toBe("untouched");
  });
});
