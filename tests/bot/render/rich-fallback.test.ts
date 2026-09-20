import { describe, expect, it } from "vitest";
import { buildAlignedTableText } from "../../../src/bot/render/block-plain-text.js";
import { countRichChars, toRichBlock } from "../../../src/bot/render/rich-blocks.js";
import type { TelegramBlock } from "../../../src/bot/render/types.js";

describe("render fallbacks for unknown nodes and ragged tables", () => {
  it("falls back to a paragraph instead of throwing on an unknown block", () => {
    const block = { type: "mystery", foo: "bar" } as unknown as TelegramBlock;

    expect(() => toRichBlock(block)).not.toThrow();
    expect(toRichBlock(block).type).toBe("paragraph");
  });

  it("falls back to plain text instead of throwing on an unknown inline node", () => {
    const block = {
      type: "paragraph",
      inlines: [{ type: "mystery-inline", text: "keep me" }],
    } as unknown as TelegramBlock;

    const rich = toRichBlock(block);
    expect(rich.type).toBe("paragraph");
    if (rich.type === "paragraph") {
      expect(JSON.stringify(rich.text)).toContain("keep me");
    }
  });

  it("handles empty and ragged tables without Math.max blowing up", () => {
    expect(buildAlignedTableText([])).toBe("");
    expect(() => buildAlignedTableText([[], []])).not.toThrow();

    expect(toRichBlock({ type: "table", rows: [] })).toEqual({
      type: "paragraph",
      text: "",
    });

    const ragged = toRichBlock({ type: "table", rows: [["a", "b"], ["only"]] });
    expect(ragged.type).toBe("table");
  });

  it("uses a conservative upper bound for unknown rich blocks instead of zero", () => {
    const unknown = { type: "future-block", payload: "x".repeat(50) } as never;
    expect(countRichChars(unknown)).toBeGreaterThan(0);
  });
});
