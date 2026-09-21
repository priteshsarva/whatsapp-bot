# SPP WhatsApp bot

No-AI support bot. Runs on its own server; talks to the backend's `/internal/wa` routes.

## Setup
1. Backend: run `UltimateScrapperV2/portal/whatsapp.sql` in the Supabase SQL editor, add `WA_INTERNAL_KEY=<32+ random chars>` to the backend `.env`, then restart it.
2. Here: `cp .env.example .env`, fill it in (same key), `npm install`.
3. `npm start`, then scan the QR with the **bot phone** (WhatsApp → Linked devices). The QR also shows in Portal → Admin → WhatsApp bot.
4. Keep it running: `pm2 start npm --name wa-bot -- start`. Session is saved in `./auth`; don't delete it or you'll need to scan again.

Node 20.6+ (uses `--env-file`).

## Owner (OWNER_PHONE) commands
- Quote-reply a question message with your answer
- `#12 <answer>`: answer it and save as a FAQ
- `#12 =5`: send FAQ 5 and learn this wording
- `#12 skip`
- `on 98xxxxxxxx` / `off 98xxxxxxxx`: hand a chat to the bot (including an old one) or keep the bot out of it

## Which chats the bot handles
- Only chats that start on or after `GO_LIVE`. Chats found in WhatsApp's history sync when you scan the QR are marked legacy, and the bot never touches them.
- You start a chat by typing the first message yourself on the bot phone. The bot carries on once the client replies.
- If you type in a chat after the client has replied, the bot stays quiet there for `PAUSE_MIN` minutes.
- Follow-ups go out after `FOLLOWUP_DAYS` quiet days, at most `FOLLOWUP_MAX` times, between 10:00 and 19:00 IST. They are skipped while a question is waiting on you. A client can reply "stop" to stop them.
- Every day, the first run after 10:00 IST sends you a list of questions you haven't answered for more than 24h.

## Keep the number safe
The bot only replies and never sends bulk messages. Open WhatsApp on the bot phone at least every few days, or WhatsApp drops linked devices.
