import type { Bot, Context, NextFunction } from "grammy";
import { isAllowedUser } from "../../app/stores/settings-store.js";
import { settingsCommand } from "../commands/settings-command.js";
import { opencodeStartCommand } from "../commands/opencode-start-command.js";
import { opencodeStopCommand } from "../commands/opencode-stop-command.js";
import { projectsCommand } from "../commands/projects-command.js";
import { worktreeCommand } from "../commands/worktree-command.js";
import { openCommand } from "../commands/open-command.js";
import { lsCommand } from "../commands/ls-command.js";
import { sessionsCommand } from "../commands/sessions-command.js";
import { messagesCommand } from "../commands/messages-command.js";
import { newCommand } from "../commands/new-command.js";
import { abortCommand } from "../commands/abort-command.js";
import { detachCommand } from "../commands/detach-command.js";
import { taskCommand } from "../commands/task-command.js";
import { taskListCommand } from "../commands/tasklist-command.js";
import { renameCommand } from "../commands/rename-command.js";
import { commandsCommand } from "../commands/command-catalog-command.js";
import { skillsCommand } from "../commands/skills-catalog-command.js";
import { mcpsCommand } from "../commands/mcp-catalog-command.js";
import { showModelSelectionMenu } from "../menus/model-selection-menu.js";
import { showAgentSelectionMenu } from "../menus/agent-selection-menu.js";
import { showVariantSelectionMenu } from "../menus/variant-selection-menu.js";
import { startCommand } from "../commands/start-command.js";
import { helpCommand } from "../commands/help-command.js";
import { statusCommand } from "../commands/status-command.js";
import { languageCommand } from "../commands/language-command.js";
import { inlineModelCommand } from "../commands/inline-model-command.js";
import { allowCommand } from "../commands/allow-command.js";
import { testModelsCommand } from "../commands/model-test-command.js";
import { BOT_COMMANDS } from "../commands/definitions.js";
import { logger } from "../../utils/logger.js";
import { flushPendingPrompt } from "../handlers/message-merger.js";
import {
  LocalCommandRegistry,
  type LocalCommandResult,
} from "../../app/services/local-command-registry.js";
import { sendMessageWithMarkdownFallback } from "../messages/send-with-markdown-fallback.js";
import { t } from "../../i18n/index.js";

interface CommandRouterDeps {
  ensureEventSubscription: (directory: string) => Promise<void>;
  clearRuntimeState: (reason: string) => void;
  localCommandRegistry?: LocalCommandRegistry;
}

const initializedCommandChats = new Set<number>();
export async function ensureCommandsInitialized(
  ctx: Context,
  next: NextFunction,
  localCommandRegistry = LocalCommandRegistry.empty(),
): Promise<void> {
  if (!ctx.from || !isAllowedUser(ctx.from.id)) {
    await next();
    return;
  }

  if (!ctx.chat) {
    // Inline queries and chosen results carry no chat context by design.
    if (!ctx.message && !ctx.callbackQuery) {
      logger.debug("[Bot] Skipping command init: no chat context on this update type");
      await next();
      return;
    }
    logger.warn("[Bot] Cannot initialize commands: chat context is missing");
    await next();
    return;
  }

  // Guest-mode updates come from chats the bot is not a member of, where it
  // cannot manage the command list.
  if (ctx.update.guest_message) {
    await next();
    return;
  }

  if (initializedCommandChats.has(ctx.chat.id)) {
    await next();
    return;
  }

  try {
    await ctx.api.setMyCommands([...BOT_COMMANDS, ...localCommandRegistry.definitions()], {
      scope: {
        type: "chat",
        chat_id: ctx.chat.id,
      },
    });

    initializedCommandChats.add(ctx.chat.id);
    logger.debug(`[Bot] Commands initialized for authorized user (chat_id=${ctx.chat.id})`);
  } catch (err) {
    // 403 (blocked/kicked/no rights) is routine, not a malfunction.
    if (isForbiddenTelegramError(err)) {
      logger.debug("[Bot] Cannot set commands here (no rights), skipping:", err);
    } else {
      logger.error("[Bot] Failed to set commands:", err);
    }
  }

  await next();
}

function isForbiddenTelegramError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const errorCode = Reflect.get(error, "error_code");
  if (errorCode === 403) {
    return true;
  }
  const description = Reflect.get(error, "description");
  return (
    typeof description === "string" &&
    /forbidden|kicked|blocked|not a member|have no rights/i.test(description)
  );
}

export function registerCommandRouter(bot: Bot<Context>, deps: CommandRouterDeps): void {
  const registry = deps.localCommandRegistry ?? LocalCommandRegistry.empty();
  bot.use(async (ctx, next) => {
    if (ctx.chat && ctx.message?.text?.startsWith("/")) {
      flushPendingPrompt(ctx.chat.id);
    }
    await next();
  });

  bot.command("start", startCommand);
  bot.command("help", helpCommand);
  bot.command("status", statusCommand);
  bot.command("language", languageCommand);
  bot.command("inlinemodel", inlineModelCommand);
  bot.command("allow", allowCommand);
  bot.command("testmodels", testModelsCommand);
  bot.command("settings", settingsCommand);
  bot.command("opencode_start", opencodeStartCommand);
  bot.command("opencode_stop", (ctx) =>
    opencodeStopCommand(ctx, { clearRuntimeState: deps.clearRuntimeState }),
  );
  bot.command("projects", projectsCommand);
  bot.command("worktree", worktreeCommand);
  bot.command("open", openCommand);
  bot.command("ls", lsCommand);
  bot.command("sessions", sessionsCommand);
  bot.command("messages", messagesCommand);
  bot.command("new", (ctx) => newCommand(ctx, { bot, ensureEventSubscription: deps.ensureEventSubscription }));
  bot.command("abort", abortCommand);
  bot.command("detach", detachCommand);
  bot.command("task", taskCommand);
  bot.command("tasklist", taskListCommand);
  bot.command("rename", renameCommand);
  bot.command("commands", commandsCommand);
  bot.command("skills", skillsCommand);
  bot.command("mcps", mcpsCommand);
  bot.command("model", async (ctx) => {
    try {
      await showModelSelectionMenu(ctx);
    } catch (err) {
      logger.error("[Bot] Error showing model menu:", err);
      await ctx.reply(t("error.load_models"));
    }
  });
  bot.command("agent", async (ctx) => {
    try {
      await showAgentSelectionMenu(ctx);
    } catch (err) {
      logger.error("[Bot] Error showing agent menu:", err);
      await ctx.reply(t("error.load_agents"));
    }
  });
  bot.command("variant", async (ctx) => {
    try {
      await showVariantSelectionMenu(ctx);
    } catch (err) {
      logger.error("[Bot] Error showing variant menu:", err);
      await ctx.reply(t("error.load_variants"));
    }
  });
  for (const definition of registry.definitions()) {
    bot.command(definition.command, async (ctx) => {
      const result = await registry.execute(definition.command);
      if (!ctx.chat) return;
      await sendMessageWithMarkdownFallback({
        api: ctx.api,
        chatId: ctx.chat.id,
        text: localCommandReply(result),
      });
    });
  }
}

function localCommandReply(result: LocalCommandResult): string {
  switch (result.kind) {
    case "success": return result.text;
    case "empty": return t("local_command.empty_output");
    case "timeout": return t("local_command.timeout");
    case "failed": return t("local_command.failed", { exitCode: result.exitCode ?? "unknown", stderr: result.stderr });
  }
}
