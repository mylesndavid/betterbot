---
name: cap-search
type: capability
---
# Web Search — Setup Guide

Search the internet for current information, news, research.

## Setup
You need a search API key. Options:
1. **Tavily** (tavily.com) — Store key as `tavily_api_key`
2. **Perplexity** (perplexity.ai) — Store key as `perplexity_api_key`
3. **Serper** (serper.dev) — free tier, 2500/mo. Store key as `serper_api_key`
4. **Brave Search** (brave.com/search/api) — free tier, 2000/mo. Store key as `brave_search_key`

## Setup Steps
1. Ask user which search provider they prefer
2. Guide them to sign up and get an API key
3. Store: `store_credential("serper_api_key", "KEY")` (or whichever provider)

Or tell the user to run: `betterbot setup search`

## Usage
`web_search(query)` is a built-in tool — no custom tool needed. It auto-detects which provider is configured.
