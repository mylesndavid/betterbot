---
name: cap-calendar-google
type: capability
---
# Google Calendar — Setup Guide

Read, create, update, and delete Google Calendar events via the Calendar API v3. The heartbeat also checks for upcoming events and notifies the user.

## Setup

### 1. Create Google Cloud OAuth Credentials

1. Go to [Google Cloud Console](https://console.cloud.google.com/apis/credentials)
2. Create a project (or use an existing one)
3. Enable the **Google Calendar API** (APIs & Services > Library > search "Calendar")
4. Go to **APIs & Services > Credentials > Create Credentials > OAuth 2.0 Client ID**
5. Application type: **Desktop app**
6. Copy the Client ID and Client Secret

### 2. Store Credentials

```bash
betterbot creds set google_client_id YOUR_CLIENT_ID
betterbot creds set google_client_secret YOUR_CLIENT_SECRET
```

### 3. Authorize

```bash
betterbot auth google
```

This opens a browser for Google OAuth consent. Grant calendar access, and the refresh token is automatically stored in Keychain.

## Available Tools

| Tool | Description |
|------|-------------|
| `calendar_today()` | Get today's remaining events across all calendars |
| `calendar_upcoming(hours?)` | Events in next N hours (default 24) |
| `calendar_create_event(title, start, ...)` | Create an event with optional end, description, location, attendees |
| `calendar_quick_add(text)` | Natural language: "Lunch with Bob tomorrow at noon" |
| `calendar_update_event(event_id, ...)` | Modify an existing event's title, time, location, etc. |
| `calendar_delete_event(event_id)` | Delete an event |

## Heartbeat Integration

The heartbeat checks Google Calendar every cycle (when `calendar` is in `heartbeat.sources`):
- Fetches events in the next 30 minutes
- New events are surfaced to triage like: "Meeting with Alice in 15 min"
- Events are deduped by event ID so the user isn't spammed

## Notes

- The `calendar` parameter on tools defaults to the user's primary calendar
- To target a specific calendar, pass its calendar ID (visible in Google Calendar settings)
- Access token refreshes automatically (~1hr TTL, cached in memory)
- If tokens expire or are revoked, run `betterbot auth google` again
