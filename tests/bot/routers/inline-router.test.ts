import { describe, expect, it, vi } from "vitest";
import type { Bot, Context } from "grammy";
import { registerInlineRouter } from "../../../src/bot/routers/inline-router.js";

function createRecordingBot(): { bot: Bot<Context>; filters: string[] } {
  const filters: string[] = [];
  const bot = {
    on: vi.fn((filter: string) => {
      filters.push(filter);
    }),
    api: {},
  } as unknown as Bot<Context>;
  return { bot, filters };
}

describe("bot/routers/inline-router", () => {
  it("registers no inline mode handlers while guest mode stays", () => {
    const { bot, filters } = createRecordingBot();

    registerInlineRouter(bot, { ensureEventSubscription: vi.fn() });

    expect(filters).not.toContain("inline_query");
    expect(filters).not.toContain("chosen_inline_result");
    expect(filters).toContain("guest_message");
  });
});
