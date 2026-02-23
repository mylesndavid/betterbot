---
name: cap-email
type: capability
---
# Email (Read/Send) — Setup Guide

Gmail via IMAP/SMTP using App Passwords.

## What You Need
- `google_email` credential — the user's Gmail address
- `google_app_password` credential — a Google App Password (NOT their regular password)

## Setup Steps
1. Ask the user for their Gmail address
2. Guide them to generate an App Password:
   - Go to myaccount.google.com > Security > 2-Step Verification > App Passwords
   - Create one for "Mail" on "Other (BetterBot)"
   - Copy the 16-character password
3. Store both:
   - `store_credential("google_email", "user@gmail.com")`
   - `store_credential("google_app_password", "xxxx xxxx xxxx xxxx")`
4. Or tell the user to run: `claw setup email`

## Tools Available When Active
- `check_email(unread_only?, limit?)` — check inbox
- `read_email(id)` — read full email by sequence number
- `send_email(to, subject, body)` — send via Gmail SMTP

## Notes
- App Passwords require 2-Step Verification enabled on the Google account
- The password is 16 characters with spaces — store it exactly as shown
