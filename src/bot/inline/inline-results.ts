import { t } from "../../i18n/index.js";

export interface InlineArticleResult {
  type: "article";
  id: string;
  title: string;
  description: string;
  input_message_content: {
    message_text: string;
  };
}

export interface InlineSnapshot {
  projectName: string | null;
  sessionTitle: string | null;
  modelLabel: string | null;
  contextLine: string | null;
}

export const INLINE_STATUS_RESULT_ID = "status";
const INLINE_ASK_RESULT_PREFIX = "ask:";
const PENDING_QUERY_TTL_MS = 10 * 60 * 1000;
const MAX_INLINE_QUERY_LENGTH = 4000;

interface PendingInlineQuery {
  text: string;
  createdAt: number;
}

const pendingQueries = new Map<string, PendingInlineQuery>();
let pendingQueryCounter = 0;

function prunePendingQueries(now: number): void {
  for (const [id, pending] of pendingQueries) {
    if (now - pending.createdAt > PENDING_QUERY_TTL_MS) {
      pendingQueries.delete(id);
    }
  }
}

/** Stores a query for later retrieval from chosen_inline_result (ids are max 64 bytes). */
export function registerPendingInlineQuery(text: string): string {
  const now = Date.now();
  prunePendingQueries(now);
  pendingQueryCounter += 1;
  const id = `${INLINE_ASK_RESULT_PREFIX}${pendingQueryCounter.toString(36)}-${now.toString(36)}`;
  pendingQueries.set(id, { text, createdAt: now });
  return id;
}

/** Consumes a pending query once; returns null for unknown/expired ids. */
export function consumePendingInlineQuery(resultId: string): string | null {
  if (!resultId.startsWith(INLINE_ASK_RESULT_PREFIX)) {
    return null;
  }
  const pending = pendingQueries.get(resultId);
  if (!pending) {
    return null;
  }
  pendingQueries.delete(resultId);
  if (Date.now() - pending.createdAt > PENDING_QUERY_TTL_MS) {
    return null;
  }
  return pending.text;
}

/** Inline messages cap at 4096 chars; keep headroom and mark truncation. */
export function truncateInlineText(text: string, limit = 4000): string {
  const trimmed = text.trim();
  if (trimmed.length <= limit) {
    return trimmed;
  }
  return `${trimmed.slice(0, limit - 1)}…`;
}

function buildStatusMessageText(snapshot: InlineSnapshot): string {
  const lines = [
    `📊 ${t("inline.status.title")}`,
    `${t("status.project_selected", { project: snapshot.projectName ?? t("common.unknown") })}`,
  ];
  if (snapshot.sessionTitle) {
    lines.push(t("status.session_selected", { title: snapshot.sessionTitle }));
  }
  if (snapshot.modelLabel) {
    lines.push(t("status.line.model", { model: snapshot.modelLabel }));
  }
  if (snapshot.contextLine) {
    lines.push(snapshot.contextLine);
  }
  return lines.join("\n");
}

/**
 * Builds inline answers: always a status card, plus a "run in current
 * session" action when the user typed a question. Tapping the action posts a
 * visible placeholder and the answer is delivered in the bot DM chat.
 */
export function buildInlineResults(
  query: string,
  snapshot: InlineSnapshot,
): InlineArticleResult[] {
  const results: InlineArticleResult[] = [
    {
      type: "article",
      id: INLINE_STATUS_RESULT_ID,
      title: t("inline.status.title"),
      description: t("inline.status.description"),
      input_message_content: {
        message_text: buildStatusMessageText(snapshot),
      },
    },
  ];

  const text = query.trim().slice(0, MAX_INLINE_QUERY_LENGTH);
  if (text) {
    results.unshift({
      type: "article",
      id: registerPendingInlineQuery(text),
      title: t("inline.ask.title"),
      description: t("inline.ask.description", { query: text }),
      input_message_content: {
        message_text: t("inline.posted.text", { query: text }),
      },
    });
  }

  return results;
}
