---
name: cap-slack
type: capability
---
# Slack — Setup Guide

Read channels and send messages in Slack.

## What You Need
- `slack_bot_token` credential — from a Slack app (`xoxb-...`)

## Setup Steps
1. User creates a Slack app at api.slack.com/apps
2. Add OAuth scopes: `chat:write`, `channels:read`, `channels:history`, `users:read`
3. Install app to workspace
4. Copy the Bot User OAuth Token (`xoxb-...`)
5. Store: `store_credential("slack_bot_token", "xoxb-...")`
6. Invite the bot to channels: `/invite @botname` in each channel

Or tell the user to run: `betterbot setup slack`

## Usage
All Slack tools are built-in:
- `slack_list_channels()` — list channels the bot can see
- `slack_read_channel(channel, limit?)` — read recent messages
- `slack_send_message(channel, text)` — send a message

## Notes
- Channel can be a name ("general") or ID
- User IDs are auto-resolved to display names
- To set Slack as the notification channel: `update_config({ key: "notifyChannel", value: "slack" })`
