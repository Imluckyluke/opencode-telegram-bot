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

export interface GuestDocumentInput {
  fileId: string;
  fileSize?: number | undefined;
  mime?: string | undefined;
  filename?: string | undefined;
}

export interface GuestVoiceInput {
  fileId: string;
  fileSize?: number | undefined;
  mime?: string | undefined;
}

interface PhotoSizeLike {
  file_id: string;
  file_size?: number | undefined;
}

interface DocumentLike {
  file_id: string;
  file_size?: number | undefined;
  mime_type?: string | undefined;
  file_name?: string | undefined;
}

interface AudioLike {
  file_id: string;
  file_size?: number | undefined;
  mime_type?: string | undefined;
}

interface VideoLike {
  file_id: string;
  file_size?: number | undefined;
  mime_type?: string | undefined;
  file_name?: string | undefined;
}

interface GuestMessageLike {
  text?: string | undefined;
  caption?: string | undefined;
  photo?: PhotoSizeLike[] | undefined;
  document?: DocumentLike | undefined;
  voice?: AudioLike | undefined;
  audio?: AudioLike | undefined;
  animation?: VideoLike | undefined;
  video?: VideoLike | undefined;
  reply_to_message?: GuestMessageLike | undefined;
}

/** GIF/animation or video, direct or from the replied-to message. */
export function extractGuestVideo(message: GuestMessageLike | undefined): GuestDocumentInput | null {
  const media =
    message?.animation ??
    message?.video ??
    message?.reply_to_message?.animation ??
    message?.reply_to_message?.video;
  if (!media?.file_id) {
    return null;
  }
  const isAnimation = Boolean(message?.animation ?? message?.reply_to_message?.animation);
  return {
    fileId: media.file_id,
    fileSize: media.file_size,
    mime: media.mime_type || "video/mp4",
    filename: media.file_name || (isAnimation ? "animation.mp4" : "video.mp4"),
  };
}

/** Text (or caption) of the replied-to message, if any. */
export function extractGuestReplyText(message: GuestMessageLike | undefined): string | null {
  const reply = message?.reply_to_message;
  const text = (reply?.text ?? reply?.caption ?? "").trim();
  if (!text) {
    return null;
  }
  return text.length > 2000 ? `${text.slice(0, 1999)}…` : text;
}

/** Removes @bot mentions so the model never sees its own handle as content. */
export function stripBotMention(text: string, botUsername: string | null): string {
  if (!botUsername) {
    return text;
  }
  const withoutMention = text.replace(
    new RegExp(`@${botUsername.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "gi"),
    "",
  );
  return withoutMention.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
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

/** Document from the message itself, falling back to the replied-to message. */
export function extractGuestDocument(
  message: GuestMessageLike | undefined,
): GuestDocumentInput | null {
  const doc = message?.document ?? message?.reply_to_message?.document;
  if (!doc?.file_id) {
    return null;
  }
  return {
    fileId: doc.file_id,
    fileSize: doc.file_size,
    mime: doc.mime_type,
    filename: doc.file_name,
  };
}

/** Filename with the right extension for STT, derived from the audio mime. */
export function guestVoiceFilename(mime: string | undefined): string {
  if (mime?.includes("mp3") || mime?.includes("mpeg")) {
    return "voice.mp3";
  }
  if (mime?.includes("mp4") || mime?.includes("m4a") || mime?.includes("x-m4a")) {
    return "voice.m4a";
  }
  return "voice.ogg";
}

/** Voice/audio note from the message itself, falling back to the replied-to message. */
export function extractGuestVoice(message: GuestMessageLike | undefined): GuestVoiceInput | null {
  const audio = message?.voice ?? message?.audio ?? message?.reply_to_message?.voice ?? message?.reply_to_message?.audio;
  if (!audio?.file_id) {
    return null;
  }
  return {
    fileId: audio.file_id,
    fileSize: audio.file_size,
    mime: audio.mime_type,
  };
}
