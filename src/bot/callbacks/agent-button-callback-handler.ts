import type { Bot, Context } from "grammy";
import { createIncomingPrompt } from "../../app/types/prompt.js";
import { t } from "../../i18n/index.js";
import { logger } from "../../utils/logger.js";
import { processUserPrompt } from "../handlers/prompt.js";
import { parseAgentButtonCallback, resolveAgentButtonValue } from "../inline/agent-buttons.js";
import { truncateTextSafe } from "../render/text-splitter.js";
import { alert } from "./feedback.js";

interface AgentButtonCallbackDeps {
  bot: Bot<Context>;
  ensureEventSubscription: (directory: string) => Promise<void>;
}

/**
 * Answers a tap on an agent-authored in-text button (`[label](btn:value)`).
 * The button value is injected as the user's next prompt in the current
 * session, so tapping behaves exactly like typing the value and sending it.
 */
export async function handleAgentButtonCallback(
  ctx: Context,
  deps: AgentButtonCallbackDeps,
): Promise<boolean> {
  const data = ctx.callbackQuery?.data;
  const parsed = data ? parseAgentButtonCallback(data) : null;
  if (!parsed) {
    return false;
  }

  const value = resolveAgentButtonValue(parsed);
  if (!value) {
    await alert(ctx, "inline.inactive_callback");
    return true;
  }

  await ctx.answerCallbackQuery({ text: truncateTextSafe(`✓ ${value}`, 200) }).catch(() => {});

  let delivered = false;
  try {
    delivered = await processUserPrompt(ctx, createIncomingPrompt(value), deps);
  } catch (err) {
    logger.warn("[Bot] Agent button prompt failed:", err);
  }
  if (!delivered) {
    // The callback was already answered with the checkmark toast above, so a
    // second answerCallbackQuery would be silently dropped. Tell the user in chat.
    await ctx.reply(t("callback.processing_error")).catch((err) => {
      logger.warn("[Bot] Failed to report agent button failure:", err);
    });
  }
  return true;
}
