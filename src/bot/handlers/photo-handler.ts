import type { Context } from "grammy";
import { createIncomingPrompt, type IncomingPrompt } from "../../app/types/prompt.js";
import { getModelCapabilities, supportsInput } from "../../app/services/model-capabilities-service.js";
import { getStoredModel } from "../../app/services/model-selection-service.js";
import { logger } from "../../utils/logger.js";
import { t } from "../../i18n/index.js";
import { flushPendingPrompt } from "./message-merger.js";
import { processUserPrompt, type ProcessPromptDeps } from "./prompt.js";
import {
  rejectQueuedMediaBeforePreparation,
  tryEnqueuePromptIfBusy,
} from "./prompt-queue-dispatch.js";

export interface PhotoHandlerDeps extends ProcessPromptDeps {
  processPrompt?: (
    ctx: Context,
    input: IncomingPrompt,
    deps: ProcessPromptDeps,
  ) => Promise<boolean>;
}

export async function handlePhotoMessage(ctx: Context, deps: PhotoHandlerDeps): Promise<void> {
  const photos = ctx.message?.photo;
  if (!photos || photos.length === 0) {
    return;
  }

  flushPendingPrompt(ctx.chat!.id);

  const caption = ctx.message.caption || "";
  const largestPhoto = photos[photos.length - 1];
  if (!largestPhoto) {
    return;
  }

  // Mirror document-handler: check the model capability BEFORE queueing or
  // downloading, so an image never waits in the queue for a model that cannot
  // read it. prepareTelegramPhotos keeps its own check as defense in depth.
  const storedModel = (deps.getStoredModel ?? getStoredModel)();
  const capabilities = await (deps.getModelCapabilities ?? getModelCapabilities)(
    storedModel.providerID,
    storedModel.modelID,
  );
  if (!supportsInput(capabilities, "image")) {
    logger.warn(
      `[Photo] Model ${storedModel.providerID}/${storedModel.modelID} doesn't support image input`,
    );
    await ctx.reply(t("bot.photo_model_no_image"));
    if (caption.trim().length > 0) {
      const textInput = createIncomingPrompt(caption, {});
      if (
        await tryEnqueuePromptIfBusy(ctx, {
          ...textInput,
          displayText: caption.trim(),
        })
      ) {
        return;
      }
      await (deps.processPrompt ?? processUserPrompt)(ctx, textInput, deps);
    }
    return;
  }

  const input = createIncomingPrompt(caption, {
    photos: [{ fileId: largestPhoto.file_id, filename: "photo.jpg", source: "standalone" }],
  });
  if (await rejectQueuedMediaBeforePreparation(ctx, largestPhoto.file_size)) {
    return;
  }
  if (
    await tryEnqueuePromptIfBusy(ctx, {
      ...input,
      displayText: caption.trim() || "[Photo]",
      ...(largestPhoto.file_size === undefined ? {} : { mediaBytes: largestPhoto.file_size }),
    })
  ) {
    return;
  }

  await (deps.processPrompt ?? processUserPrompt)(ctx, input, deps);
}
