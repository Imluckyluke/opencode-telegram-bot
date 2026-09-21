import { opencodeClient } from "../../opencode/client.js";
import {
  getModelSelectionLists,
  getStoredInlineModel,
  getStoredModel,
} from "./model-selection-service.js";
import {
  registerScheduledTaskSessionIgnore,
  removeScheduledTaskSessionIgnore,
} from "./scheduled-task-session-ignore-service.js";
import { logger } from "../../utils/logger.js";

export interface ModelProbeTarget {
  providerID: string;
  modelID: string;
  source: string;
}

export interface ModelProbeResult extends ModelProbeTarget {
  ok: boolean;
  latencyMs?: number | undefined;
  snippet?: string | undefined;
  error?: string | undefined;
}

export const MODEL_PROBE_PROMPT = "Reply with exactly: OK";
export const MODEL_PROBE_TIMEOUT_MS = 75_000;
export const MODEL_PROBE_POLL_MS = 3000;
export const MODEL_PROBE_MAX_TARGETS = 15;

function targetKey(target: { providerID: string; modelID: string }): string {
  return `${target.providerID}/${target.modelID}`;
}

/**
 * Collects candidate free models: configured defaults, favorites, recents,
 * plus every catalog model with "free" in its id (opencode free-tier naming).
 * Capped and deduped.
 */
export async function collectModelProbeTargets(): Promise<ModelProbeTarget[]> {
  const targets = new Map<string, ModelProbeTarget>();
  const add = (providerID: string, modelID: string, source: string) => {
    if (!providerID || !modelID) {
      return;
    }
    const key = targetKey({ providerID, modelID });
    if (!targets.has(key)) {
      targets.set(key, { providerID, modelID, source });
    }
  };

  const main = getStoredModel();
  add(main.providerID, main.modelID, "default");
  try {
    const inline = getStoredInlineModel();
    add(inline.providerID, inline.modelID, "inline-default");
  } catch (error) {
    logger.debug("[ModelTest] Could not resolve inline model:", error);
  }

  try {
    const lists = await getModelSelectionLists();
    for (const model of [...lists.favorites, ...lists.recent]) {
      add(model.providerID, model.modelID, "favorite");
    }
  } catch (error) {
    logger.debug("[ModelTest] Could not load favorites/recent:", error);
  }

  try {
    const { data, error } = await opencodeClient.config.providers();
    if (!error && data) {
      for (const provider of data.providers) {
        for (const modelID of Object.keys(provider.models ?? {})) {
          if (modelID.toLowerCase().includes("free")) {
            add(provider.id, modelID, "free-tier");
          }
        }
      }
    }
  } catch (error) {
    logger.debug("[ModelTest] Could not scan catalog for free models:", error);
  }

  return [...targets.values()].slice(0, MODEL_PROBE_MAX_TARGETS);
}

type ProbeMessageLike = {
  info: {
    role?: string;
    summary?: boolean;
    time?: { created?: number; completed?: number };
  };
  parts: Array<{ type?: string; text?: string }>;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Probes one model in a throwaway session: asks for a fixed reply and waits
 * for an assistant completion. The session is ignored by background
 * notifications and removed from the ignore list afterwards.
 */
export async function probeModel(
  directory: string,
  target: ModelProbeTarget,
  timeoutMs: number = MODEL_PROBE_TIMEOUT_MS,
): Promise<ModelProbeResult> {
  const startedAt = Date.now();
  const { data: session, error: createError } = await opencodeClient.session.create({
    directory,
  });
  if (createError || !session?.id) {
    return {
      ...target,
      ok: false,
      error: createError ? String(createError).slice(0, 200) : "session create failed",
    };
  }

  await registerScheduledTaskSessionIgnore(session.id).catch(() => {});
  try {
    const { error: promptError } = await opencodeClient.session.promptAsync({
      sessionID: session.id,
      directory,
      parts: [{ type: "text", text: MODEL_PROBE_PROMPT }],
      model: { providerID: target.providerID, modelID: target.modelID },
    });
    if (promptError) {
      return { ...target, ok: false, error: String(promptError).slice(0, 200) };
    }

    const deadline = Date.now() + timeoutMs;
    for (;;) {
      await sleep(MODEL_PROBE_POLL_MS);
      const snapshot = await readProbeSnapshot(session.id, directory, startedAt).catch(
        () => null,
      );
      if (snapshot?.completed) {
        return {
          ...target,
          ok: true,
          latencyMs: Date.now() - startedAt,
          snippet: snapshot.text.slice(0, 120),
        };
      }
      if (Date.now() > deadline) {
        return { ...target, ok: false, error: "timeout waiting for reply" };
      }
    }
  } finally {
    await removeScheduledTaskSessionIgnore(session.id).catch(() => {});
  }
}

async function readProbeSnapshot(
  sessionId: string,
  directory: string,
  since: number,
): Promise<{ text: string; completed: boolean } | null> {
  const { data, error } = await opencodeClient.session.messages({
    sessionID: sessionId,
    directory,
  });
  if (error || !data) {
    return null;
  }
  let best: { created: number; text: string; completed: boolean } | null = null;
  for (const message of data as ProbeMessageLike[]) {
    if (message.info.role !== "assistant" || message.info.summary) {
      continue;
    }
    const created = message.info.time?.created ?? 0;
    if (created < since) {
      continue;
    }
    const text = message.parts
      .filter((part) => part.type === "text" && typeof part.text === "string")
      .map((part) => part.text as string)
      .join("")
      .trim();
    if (!text) {
      continue;
    }
    if (!best || created >= best.created) {
      best = { created, text, completed: Boolean(message.info.time?.completed) };
    }
  }
  return best;
}
