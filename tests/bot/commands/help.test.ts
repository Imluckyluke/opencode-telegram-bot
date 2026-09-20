import { describe, expect, it, vi } from "vitest";
import type { Context } from "grammy";
import { formatHelpText, helpCommand } from "../../../src/bot/commands/help-command.js";
import { getLocalizedBotCommands } from "../../../src/bot/commands/definitions.js";
import { defined } from "../../helpers/defined.js";

function createContext(): Context {
  return {
    chat: { id: 777 },
    api: { sendMessage: vi.fn().mockResolvedValue({ message_id: 1 }) },
    reply: vi.fn().mockResolvedValue(undefined),
  } as unknown as Context;
}

describe("bot/commands/help-command", () => {
  it("returns full commands list from centralized definitions", async () => {
    const ctx = createContext();

    await helpCommand(ctx as never);

    expect(ctx.reply).not.toHaveBeenCalled();
    const sendMessage = vi.mocked(ctx.api.sendMessage);
    expect(sendMessage).toHaveBeenCalledTimes(1);

    const call = defined(sendMessage.mock.calls[0]);
    const [chatId, helpText, options] = call;
    expect(chatId).toBe(777);
    expect(options).toMatchObject({ parse_mode: "Markdown" });

    const commands = getLocalizedBotCommands();
    for (const item of commands) {
      expect(helpText).toContain(`/${item.command}`);
      expect(helpText).toContain(item.description);
    }
  });

  it("groups commands under rich section headers", () => {
    const helpText = formatHelpText();

    expect(helpText).toContain("*");
    expect(helpText).toContain("/model");
    expect(helpText).toContain("/language");
  });

  it("falls back to plain reply without chat context", async () => {
    const ctx = { reply: vi.fn().mockResolvedValue(undefined) } as unknown as Context;

    await helpCommand(ctx as never);

    expect(ctx.reply).toHaveBeenCalledTimes(1);
  });
});
