import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Context } from "grammy";
import { handleLanguageCallback } from "../../../src/bot/callbacks/language-callback-handler.js";
import { LANGUAGE_SET_CALLBACK_PREFIX } from "../../../src/bot/menus/language-menu.js";
import { interactionManager } from "../../../src/app/managers/interaction-manager.js";
import { resetRuntimeLocale } from "../../../src/i18n/index.js";
import { defined } from "../../helpers/defined.js";

const mocked = vi.hoisted(() => ({
  setPersistedLocaleMock: vi.fn(),
}));

vi.mock("../../../src/app/stores/settings-store.js", () => ({
  setPersistedLocale: mocked.setPersistedLocaleMock,
}));

function activateLanguageMenu(): void {
  interactionManager.start({
    kind: "inline",
    expectedInput: "callback",
    metadata: {
      menuKind: "language",
      messageId: 10,
    },
  });
}

function createCallbackContext(data: string): Context {
  return {
    chat: { id: 777 },
    api: { setMyCommands: vi.fn().mockResolvedValue(undefined) },
    callbackQuery: { data, message: { message_id: 10 } },
    answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
    editMessageText: vi.fn().mockResolvedValue(undefined),
  } as unknown as Context;
}

describe("bot/callbacks/language-callback-handler", () => {
  beforeEach(() => {
    mocked.setPersistedLocaleMock.mockReset();
    resetRuntimeLocale();
    interactionManager.clear("language_test_reset");
  });

  it("ignores callbacks with another prefix", async () => {
    const ctx = createCallbackContext("settings:tts");

    expect(await handleLanguageCallback(ctx)).toBe(false);
    expect(mocked.setPersistedLocaleMock).not.toHaveBeenCalled();
  });

  it("sets and persists the selected locale and rebuilds the menu", async () => {
    activateLanguageMenu();
    const ctx = createCallbackContext(`${LANGUAGE_SET_CALLBACK_PREFIX}fa`);

    const result = await handleLanguageCallback(ctx);

    expect(result).toBe(true);
    expect(mocked.setPersistedLocaleMock).toHaveBeenCalledWith("fa");
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({
      text: expect.stringContaining("فارسی"),
    });
    const call = defined(vi.mocked(ctx.editMessageText).mock.calls[0]);
    expect(call[0]).toContain("زبان بات را انتخاب کنید");
    expect(defined(vi.mocked(ctx.api!.setMyCommands).mock.calls[0])[0]).toEqual(
      expect.arrayContaining([expect.objectContaining({ command: "language" })]),
    );
  });

  it("rejects unknown locale codes", async () => {
    activateLanguageMenu();
    const ctx = createCallbackContext(`${LANGUAGE_SET_CALLBACK_PREFIX}xx`);

    const result = await handleLanguageCallback(ctx);

    expect(result).toBe(true);
    expect(mocked.setPersistedLocaleMock).not.toHaveBeenCalled();
    expect(ctx.editMessageText).not.toHaveBeenCalled();
  });
});
