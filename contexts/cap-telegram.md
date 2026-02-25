---
name: cap-telegram
type: capability
---
# Telegram — Setup Guide

Telegram bot for two-way messaging with your human.

## What You Need
- `telegram_bot_token` credential — from @BotFather
- `telegram_chat_id` credential — the user's chat ID
- `telegram.allowedChatIds` in config — whitelist

## Setup Steps (you can do all of this)

1. Ask the user to create a bot via @BotFather on Telegram (/newbot command) and give you the token
2. Store the token:
   ```
   store_credential("telegram_bot_token", "TOKEN_FROM_USER")
   ```
3. Validate the token:
   ```
   http_request({ url: "https://api.telegram.org/bot{TOKEN}/getMe" })
   ```
4. Ask the user to send ANY message to the bot, then detect their chat ID:
   ```
   http_request({ url: "https://api.telegram.org/bot{TOKEN}/getUpdates" })
   ```
   The chat ID is in `result[last].message.chat.id`
5. Store the chat ID:
   ```
   store_credential("telegram_chat_id", "CHAT_ID")
   ```
6. Add to config allowlist:
   ```
   update_config({ key: "telegram.allowedChatIds", value: ["CHAT_ID"] })
   ```
7. Test by sending a message:
   ```
   http_request({
     url: "https://api.telegram.org/bot{TOKEN}/sendMessage",
     method: "POST",
     body: '{"chat_id": "CHAT_ID", "text": "BetterBot connected!"}'
   })
   ```

## Sending Messages
Use `notify_user(message)` — it routes to Telegram automatically when configured as the notify channel.

## Notes
- Gateway must be running for the bot to receive messages (`betterbot gateway`)
- Only whitelisted chat IDs can interact with the bot
- Set notify channel: `update_config({ key: "notifyChannel", value: "telegram" })`
