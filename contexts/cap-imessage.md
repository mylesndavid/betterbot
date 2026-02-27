---
name: cap-imessage
type: capability
---
# iMessage — Setup Guide

Send and read iMessages directly from macOS.

## Built-in Tools
- `send_imessage` — Send a message via the Messages app (AppleScript)
- `read_imessages` — Read recent messages from chat.db (SQLite)
- `search_imessages` — Search message history by keyword

## Permissions Required

### Sending (Automation)
The terminal app needs permission to control Messages.
- System Settings → Privacy & Security → Automation
- Enable "Messages" for Terminal/iTerm2/your IDE

### Reading (Full Disk Access)
Reading chat.db requires Full Disk Access for the terminal app.
- System Settings → Privacy & Security → Full Disk Access
- Add Terminal/iTerm2/your IDE

## Setup
Run `betterbot setup imessage` to test both permissions.

## Usage Notes
- Recipients can be phone numbers (+14155551234), email addresses, or contact names
- Phone numbers should include country code for reliability
- The Mac must be awake and Messages must be signed in to send
- Reading works even when Messages app is closed (queries the database directly)
- Messages from all conversations are in chat.db — be mindful of privacy

## Troubleshooting
- **Timeout on send**: macOS is blocking Automation. Check System Settings.
- **"authorization denied" on read**: Full Disk Access not granted. Check System Settings.
- **"not authorized"**: After granting permission, restart the terminal app.
- **Messages app opens briefly**: This is normal — AppleScript triggers the app to send.
