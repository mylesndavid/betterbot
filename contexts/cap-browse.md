---
name: cap-browse
type: capability
---
# Web Browse — Setup Guide

Browse web pages interactively using an ARIA-snapshot sub-agent.

## Setup
No setup needed — `browse_web(url, task)` is a built-in tool.

## Usage
```
browse_web({ url: "https://example.com", task: "Find the pricing table and extract all plan details" })
```

## Notes
- Uses ARIA snapshots (text, not screenshots) — very cheap (~$0.01 per session)
- Can interact with pages: click elements, fill forms, navigate
- Works with the user's Chrome cookies when useProfile is enabled
- For simple URL fetching (APIs, static pages), use `http_request()` instead
