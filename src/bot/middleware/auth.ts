import { Context, NextFunction } from "grammy";
import { config } from "../../config.js";
import { isAllowedUser } from "../../app/stores/settings-store.js";
import { logger } from "../../utils/logger.js";

export async function authMiddleware(ctx: Context, next: NextFunction): Promise<void> {
  const userId = ctx.from?.id;
  // Guest-mode summons arrive without membership: the authorizing party is
  // the caller, not the message sender.
  const guestCallerId = ctx.update?.guest_message?.guest_bot_caller_user?.id;

  logger.debug(
    `[Auth] Checking access: userId=${userId}, guestCallerId=${guestCallerId}, allowedUserCount=${config.telegram.allowedUserIds?.length ?? 0}, hasCallbackQuery=${!!ctx.callbackQuery}, hasMessage=${!!ctx.message}`,
  );

  if (isAllowedUser(userId) || isAllowedUser(guestCallerId)) {
    logger.debug(`[Auth] Access granted for userId=${userId}, guestCallerId=${guestCallerId}`);
    await next();
  } else {
    // Silently ignore unauthorized users
    logger.warn(`Unauthorized access attempt from user ID: ${userId}`);

    // Actively hide commands for unauthorized users by setting empty command list
    // Only do this if the chat is NOT an authorized chat
    // (to avoid resetting commands when forwarded messages are received).
    // Skipped for guest updates: the bot cannot manage group command lists.
    if (!ctx.update?.guest_message && ctx.chat?.id && !isAllowedUser(ctx.chat.id)) {
      try {
        // Set empty commands for this specific chat (more reliable than deleteMyCommands)
        await ctx.api.setMyCommands([], {
          scope: { type: "chat", chat_id: ctx.chat.id },
        });
        logger.debug(`[Auth] Set empty commands for unauthorized chat_id=${ctx.chat.id}`);
      } catch (err) {
        // Ignore errors
        logger.debug(`[Auth] Could not set empty commands: ${err}`);
      }
    }
  }
}
