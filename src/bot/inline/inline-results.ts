import { t } from "../../i18n/index.js";

export interface InlineArticleResult {
  type: "article";
  id: string;
  title: string;
  description: string;
  input_message_content: {
    message_text: string;
  };
  reply_markup?: {
    inline_keyboard: Array<Array<{ text: string; url: string }>>;
  };
}

export interface InlineSnapshot {
  projectName: string | null;
  sessionTitle: string | null;
  modelLabel: string | null;
  contextLine: string | null;
}

export const INLINE_STATUS_RESULT_ID = "status";
const INLINE_ASK_RESULT_PREFIX = "ask_";
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
  const id = `${INLINE_ASK_RESULT_PREFIX}${pendingQueryCounter.toString(36)}${now.toString(36)}`;
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

/** Keeps the asked question pinned above the streamed answer. */
export function formatInlineAnswer(query: string, answer: string): string {
  return `❓ ${query.trim()}\n\n${answer.trim()}`;
}

export interface GuestPhotoInput {
  fileId: string;
  fileSize?: number | undefined;
}

interface PhotoSizeLike {
  file_id: string;
  file_size?: number | undefined;
}

interface GuestMessageLike {
  photo?: PhotoSizeLike[] | undefined;
  reply_to_message?: { photo?: PhotoSizeLike[] | undefined } | undefined;
}

function pickLargestPhoto(photos: PhotoSizeLike[] | undefined): GuestPhotoInput | null {
  if (!photos || photos.length === 0) {
    return null;
  }
  const largest = photos[photos.length - 1];
  if (!largest || !largest.file_id) {
    return null;
  }
  return { fileId: largest.file_id, fileSize: largest.file_size };
}

/** Photo from the message itself, falling back to the replied-to message. */
export function extractGuestPhoto(message: GuestMessageLike | undefined): GuestPhotoInput | null {
  if (!message) {
    return null;
  }
  return pickLargestPhoto(message.photo) ?? pickLargestPhoto(message.reply_to_message?.photo);
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
 * visible placeholder and the answer is edited into it in place.
 * The ask action carries a button on purpose: Telegram only reports
 * inline_message_id (needed for those edits) when a keyboard is attached.
 */
export function buildInlineResults(
  query: string,
  snapshot: InlineSnapshot,
  botUsername: string | null,
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
    const askResult: InlineArticleResult = {
      type: "article",
      id: registerPendingInlineQuery(text),
      title: t("inline.ask.title"),
      description: t("inline.ask.description", { query: text }),
      input_message_content: {
        message_text: t("inline.posted.text", { query: text }),
      },
    };
    if (botUsername) {
      askResult.reply_markup = {
        inline_keyboard: [[{ text: t("inline.open_bot"), url: `https://t.me/${botUsername}` }]],
      };
    }
    results.unshift(askResult);
  }

  return results;
}
