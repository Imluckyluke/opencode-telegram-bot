import { logger } from "../../utils/logger.js";
import type { InlineNode, TelegramBlock, TelegramListItem } from "./types.js";

export function extractInlinePlainText(nodes: InlineNode[]): string {
  let result = "";

  for (const node of nodes) {
    switch (node.type) {
      case "text":
        result += node.text;
        break;
      case "bold":
      case "italic":
      case "strike":
      case "underline":
      case "spoiler":
      case "subscript":
      case "superscript":
      case "marked":
        result += extractInlinePlainText(node.children);
        break;
      case "code":
        result += node.text;
        break;
      case "link":
        result += extractInlinePlainText(node.text);
        break;
      default: {
        const unknownType = (node as { type?: unknown }).type;
        logger.warn("[TelegramRender] Unsupported inline node in plain text, skipping", {
          nodeType: typeof unknownType === "string" ? unknownType : typeof node,
        });
        const record = node as unknown as Record<string, unknown>;
        const text = record["text"];
        const value = record["value"];
        if (typeof text === "string") {
          result += text;
        } else if (typeof value === "string") {
          result += value;
        }
        break;
      }
    }
  }

  return result;
}

export function buildAlignedTableText(rows: string[][]): string {
  if (rows.length === 0) {
    return "";
  }

  const columnCount = Math.max(0, ...rows.map((row) => row.length));
  if (columnCount <= 0) {
    return rows.map((row) => row.join(" | ")).join("\n");
  }

  const normalizedRows = rows.map((row) =>
    Array.from({ length: columnCount }, (_, index) => row[index] ?? ""),
  );
  const columnWidths = Array.from({ length: columnCount }, (_, index) =>
    Math.max(0, ...normalizedRows.map((row) => row[index]?.length ?? 0)),
  );

  const formatRow = (row: string[]): string =>
    row.map((cell, index) => cell.padEnd(columnWidths[index] ?? 0, " ")).join(" | ");

  const divider = columnWidths.map((width) => "-".repeat(width)).join("-|-");
  const formattedRows = normalizedRows.map(formatRow);

  if (formattedRows.length <= 1) {
    return formattedRows.join("\n");
  }

  return [formattedRows[0], divider, ...formattedRows.slice(1)].join("\n");
}

function buildListItemText(
  item: TelegramListItem,
  index: number,
  ordered: boolean,
  start: number,
): string {
  // A task item states its state in the marker; a bullet in front reads as a second one.
  const taskPrefix = item.checked === true ? "✅ " : item.checked === false ? "🔲 " : "";
  const marker = ordered ? `${start + index}. ${taskPrefix}` : taskPrefix || "- ";
  const continuationPrefix = " ".repeat(marker.length);
  const body = item.blocks.map(toBlockPlainText).filter(Boolean).join("\n");

  return body
    .split("\n")
    .map((line, lineIndex) => `${lineIndex === 0 ? marker : continuationPrefix}${line}`)
    .join("\n");
}

export function toBlockPlainText(block: TelegramBlock): string {
  switch (block.type) {
    case "paragraph":
    case "heading":
      return extractInlinePlainText(block.inlines);
    case "blockquote":
      return block.blocks
        .map(toBlockPlainText)
        .filter(Boolean)
        .map((text) =>
          text
            .split("\n")
            .map((line) => `> ${line}`)
            .join("\n"),
        )
        .join("\n");
    case "list":
      return block.items
        .map((item, index) => buildListItemText(item, index, block.ordered, block.start ?? 1))
        .join("\n");
    case "code":
      return block.text;
    case "table":
      return buildAlignedTableText(block.rows);
    case "rule":
      return "──────────";
    case "plain":
      return block.text;
    default: {
      const unknownType = (block as { type?: unknown }).type;
      logger.warn("[TelegramRender] Unsupported block in plain text, skipping", {
        blockType: typeof unknownType === "string" ? unknownType : typeof block,
      });
      return "";
    }
  }
}
