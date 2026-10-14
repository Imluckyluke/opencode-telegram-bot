import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandContext, Context } from "grammy";
import { t } from "../../../src/i18n/index.js";

const mocked = vi.hoisted(() => ({
  reloadOpencodeConfig: vi.fn(),
  refreshModelViews: vi.fn(),
  editBotText: vi.fn(),
}));

vi.mock("../../../src/app/services/config-reload-service.js", () => ({
  reloadOpencodeConfig: mocked.reloadOpencodeConfig,
}));

vi.mock("../../../src/bot/services/model-views.js", () => ({
  refreshModelViews: mocked.refreshModelViews,
}));

vi.mock("../../../src/bot/messages/telegram-text.js", () => ({
  editBotText: mocked.editBotText,
}));

import { reloadCommand } from "../../../src/bot/commands/reload-command.js";

function createContext(messageId = 10): CommandContext<Context> {
  return {
    chat: { id: 42, type: "private" },
    api: {},
    reply: vi.fn().mockResolvedValue({ message_id: messageId }),
  } as unknown as CommandContext<Context>;
}

async function runReload(ctx: CommandContext<Context>): Promise<void> {
  await reloadCommand(ctx);
  await vi.waitFor(() => expect(mocked.editBotText).toHaveBeenCalled());
}

describe("bot/commands/reload-command", () => {
  beforeEach(() => {
    mocked.editBotText.mockReset().mockResolvedValue(undefined);
    mocked.refreshModelViews.mockReset().mockResolvedValue(undefined);
    mocked.reloadOpencodeConfig.mockReset();
  });

  it("edits the reloading message into success", async () => {
    mocked.reloadOpencodeConfig.mockResolvedValue({ kind: "success", modelChanged: false });
    const ctx = createContext();

    await runReload(ctx);

    expect(ctx.reply).toHaveBeenCalledWith(t("reload.reloading"));
    expect(mocked.editBotText).toHaveBeenCalledWith({
      api: ctx.api,
      chatId: 42,
      messageId: 10,
      text: t("reload.success"),
    });
    expect(mocked.refreshModelViews).not.toHaveBeenCalled();
  });

  it("redraws the model views when the reload replaced the selected model", async () => {
    mocked.reloadOpencodeConfig.mockResolvedValue({ kind: "success", modelChanged: true });

    await runReload(createContext());

    expect(mocked.refreshModelViews).toHaveBeenCalledOnce();
    expect(mocked.editBotText).toHaveBeenCalledWith(
      expect.objectContaining({ text: t("reload.success") }),
    );
  });

  it("shows the server's error text on failure", async () => {
    mocked.reloadOpencodeConfig.mockResolvedValue({ kind: "failed", error: "Invalid config" });

    await runReload(createContext());

    expect(mocked.editBotText).toHaveBeenCalledWith(
      expect.objectContaining({
        text: t("reload.failed_with_error", { error: "Invalid config" }),
      }),
    );
  });

  it("shows the bare failure line without error text or on a timeout", async () => {
    mocked.reloadOpencodeConfig.mockResolvedValueOnce({ kind: "failed", error: null });
    await runReload(createContext());
    expect(mocked.editBotText).toHaveBeenLastCalledWith(
      expect.objectContaining({ text: t("reload.failed") }),
    );

    mocked.editBotText.mockClear();
    mocked.reloadOpencodeConfig.mockResolvedValueOnce({ kind: "timeout" });
    await runReload(createContext());
    expect(mocked.editBotText).toHaveBeenLastCalledWith(
      expect.objectContaining({ text: t("reload.failed") }),
    );
  });

  it("ends in the failure line when the reload throws", async () => {
    mocked.reloadOpencodeConfig.mockRejectedValue(new Error("boom"));

    await runReload(createContext());

    expect(mocked.editBotText).toHaveBeenCalledWith(
      expect.objectContaining({ text: t("reload.failed") }),
    );
  });

  it("edits each status message when two reloads share one outcome", async () => {
    mocked.reloadOpencodeConfig.mockResolvedValue({ kind: "success", modelChanged: false });

    await reloadCommand(createContext(10));
    await reloadCommand(createContext(11));
    await vi.waitFor(() => expect(mocked.editBotText).toHaveBeenCalledTimes(2));

    expect(mocked.editBotText.mock.calls.map(([options]) => options.messageId)).toEqual([10, 11]);
  });
});
