---
name: cap-calendar
type: capability
---
# Apple Calendar — Setup Guide

Read and create events in Apple Calendar via AppleScript.

## Prerequisites (IMPORTANT)
macOS requires explicit permission before any process can access Calendar via AppleScript. Without this, all calendar tools will silently hang and timeout.

**First-time setup — the user must do this once:**
1. Open **System Settings > Privacy & Security > Automation**
2. Find the process running BetterClaw (Terminal, iTerm, or the Node binary) and enable **Calendar** access
3. Also check **System Settings > Privacy & Security > Calendars** — same process needs access there
4. Test by running in Terminal: `osascript -e 'tell application "Calendar" to return name of every calendar'`
5. If macOS shows a permission dialog, click **Allow**

If the tools timeout with `ETIMEDOUT`, this is almost certainly the cause.

## Setup
No API key needed. Build custom tools using AppleScript via `child_process.execSync("osascript -e '...'")`.

### Read Events Tool
Query Calendar app for events on a given date:
```applescript
tell application "Calendar"
  set targetDate to date "YYYY-MM-DD"
  -- get events from calendar "CalendarName" where start date >= targetDate
end tell
```

### Create Event Tool
```applescript
tell application "Calendar"
  tell calendar "CalendarName"
    make new event with properties {summary:"Title", start date:date "...", end date:date "..."}
  end tell
end tell
```

## Notes
- Detect available calendars first with a `get_calendar_names` helper
- Ask the user which calendar to use as primary, or default to the first one
- If calendar tools timeout, see Prerequisites above — macOS permissions are the #1 cause
- Or tell the user to run: `claw setup calendar`
