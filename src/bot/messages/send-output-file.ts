import { InputFile } from "grammy";
import type { Api, RawApi } from "grammy";
import { config } from "../../config.js";
import { t } from "../../i18n/index.js";
import { logger } from "../../utils/logger.js";

type SendDocumentApi = Pick<Api<RawApi>, "sendDocument">;

const OUTPUT_FILENAME_PREFIX = "output";

function buildOutputFilename(): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `${OUTPUT_FILENAME_PREFIX}-${timestamp}.md`;
}

/** Long assistant outputs flood the chat; sending them as a file keeps history readable. */
export function shouldSendLongOutputAsFile(text: string | null | undefined): boolean {
  if (!config.files.outputFileEnabled) {
    return false;
  }

  if (!text) {
    return false;
  }

  return text.length >= config.files.outputFileThresholdChars;
}

export async function sendLongOutputAsFile(params: {
  api: SendDocumentApi;
  chatId: number;
  text: string;
  filename?: string | undefined;
  caption?: string | undefined;
  disableNotification?: boolean | undefined;
}): Promise<boolean> {
  const { api, chatId, text } = params;
  if (!text) {
    return false;
  }

  const filename = params.filename ?? buildOutputFilename();
  const caption = (params.caption ?? t("output.file.caption")).slice(0, 1024);

  try {
    await api.sendDocument(chatId, new InputFile(Buffer.from(text, "utf-8"), filename), {
      caption,
      disable_notification: params.disableNotification ?? true,
    });
    logger.debug("[OutputFile] Sent long assistant output as file", {
      filename,
      textLength: text.length,
    });
    return true;
  } catch (error) {
    logger.warn("[OutputFile] Failed to send long output as file", error);
    return false;
  }
}
