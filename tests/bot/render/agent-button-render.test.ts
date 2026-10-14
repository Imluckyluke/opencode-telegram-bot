import { describe, expect, it } from "vitest";
import type { RichTextButton } from "grammy/types";
import { renderTelegramBlocks } from "../../../src/bot/render/pipeline.js";

function buttonsOf(markdown: string): RichTextButton[] {
  const found: RichTextButton[] = [];
  for (const part of renderTelegramBlocks(markdown)) {
    const block = part.block;
    if (block.type !== "paragraph" && block.type !== "heading") {
      continue;
    }
    const texts = Array.isArray(block.text) ? block.text : [block.text];
    for (const node of texts) {
      if (typeof node !== "string" && !Array.isArray(node) && node.type === "button") {
        found.push(node);
      }
    }
  }
  return found;
}

describe("bot/render/agent-button-render", () => {
  it("turns btn: links into in-text buttons", () => {
    const buttons = buttonsOf("Pick one: [Railway](btn:railway) or [VPS](btn:vps)");

    expect(buttons).toHaveLength(2);
    expect(buttons[0]).toEqual({
      type: "button",
      button: { text: "Railway", callback_data: "ab:railway" },
    });
    expect(buttons[1]?.button).toMatchObject({ text: "VPS", callback_data: "ab:vps" });
  });

  it("does not split an emoji when cutting a long label", () => {
    const label = `${"a".repeat(63)}😀tail`;
    const [button] = buttonsOf(`[${label}](btn:go)`);

    expect(button?.button.text).toBe("a".repeat(63));
  });

  it("keeps the label in the plain-text fallback", () => {
    const parts = renderTelegramBlocks("Pick [Railway](btn:railway) now");

    expect(parts[0]?.plainText).toContain("Railway");
    expect(parts[0]?.plainText).not.toContain("btn:");
  });

  it("leaves regular links alone", () => {
    const buttons = buttonsOf("[Docs](https://example.com)");

    expect(buttons).toHaveLength(0);
  });

  it("uses the overflow table for long values", () => {
    const buttons = buttonsOf(`[Long](${`btn:${"z".repeat(200)}`})`);

    expect(buttons).toHaveLength(1);
    const data =
      buttons[0]?.button && "callback_data" in buttons[0].button
        ? buttons[0].button.callback_data
        : "";
    expect(data.startsWith("abk:")).toBe(true);
  });

  it("turns multi-word btn: links into buttons", () => {
    const buttons = buttonsOf("[گزینه یک](btn:گزینه یک)");

    expect(buttons).toHaveLength(1);
    expect(buttons[0]?.button).toMatchObject({ text: "گزینه یک" });
  });
});
