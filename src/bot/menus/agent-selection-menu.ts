import { Context, InlineKeyboard } from "grammy";
import { fetchCurrentAgent, getAvailableAgents } from "../../app/services/agent-selection-service.js";
import { getAgentDisplayName } from "../../app/types/agent.js";
import { logger } from "../../utils/logger.js";
import { t } from "../../i18n/index.js";
import { replyWithInlineMenu } from "./inline-menu.js";

const CALLBACK_DATA_MAX_BYTES = 64;
export const AGENT_INDEX_MARKER = "#";

/**
 * Telegram rejects the whole keyboard when any callback_data exceeds 64 bytes,
 * so long (user-defined) agent names fall back to a list index.
 */
export function buildAgentCallbackData(agentName: string, index: number): string {
  const direct = `agent:${agentName}`;
  if (
    Buffer.byteLength(direct, "utf8") <= CALLBACK_DATA_MAX_BYTES &&
    !agentName.startsWith(AGENT_INDEX_MARKER)
  ) {
    return direct;
  }
  return `agent:${AGENT_INDEX_MARKER}${index}`;
}

/**
 * Resolves an agent callback payload back to the agent name.
 */
export async function resolveAgentFromCallbackPayload(payload: string): Promise<string | null> {
  if (!payload.startsWith(AGENT_INDEX_MARKER)) {
    return payload || null;
  }
  const index = Number(payload.slice(AGENT_INDEX_MARKER.length));
  if (!Number.isSafeInteger(index) || index < 0) {
    return null;
  }
  const agents = await getAvailableAgents();
  return agents[index]?.name ?? null;
}

/**
 * Build inline keyboard with available agents
 * @param currentAgent Current agent name for highlighting
 * @returns InlineKeyboard with agent selection buttons
 */
export async function buildAgentSelectionMenu(currentAgent?: string): Promise<InlineKeyboard> {
  const keyboard = new InlineKeyboard();
  const agents = await getAvailableAgents();

  if (agents.length === 0) {
    logger.warn("[AgentHandler] No available agents found");
    return keyboard;
  }

  // Add button for each agent
  agents.forEach((agent, index) => {
    const isActive = agent.name === currentAgent;
    const label = isActive
      ? `✅ ${getAgentDisplayName(agent.name)}`
      : getAgentDisplayName(agent.name);

    keyboard.text(label, buildAgentCallbackData(agent.name, index)).row();
  });

  return keyboard;
}

/**
 * Show agent selection menu
 * @param ctx grammY context
 */
export async function showAgentSelectionMenu(ctx: Context): Promise<void> {
  try {
    const currentAgent = await fetchCurrentAgent();
    const keyboard = await buildAgentSelectionMenu(currentAgent);

    if (keyboard.inline_keyboard.length === 0) {
      await ctx.reply(t("agent.menu.empty"));
      return;
    }

    const text = currentAgent
      ? t("agent.menu.current", { name: getAgentDisplayName(currentAgent) })
      : t("agent.menu.select");

    await replyWithInlineMenu(ctx, {
      menuKind: "agent",
      text,
      keyboard,
    });
  } catch (err) {
    logger.error("[AgentHandler] Error showing agent menu:", err);
    await ctx.reply(t("agent.menu.error"));
  }
}
