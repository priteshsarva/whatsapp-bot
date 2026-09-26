// WhatsApp assistant (Baileys linked device). No menus, no greeting script, no
// language question: every client message goes to the backend's /internal/wa/reply,
// which holds the conversation. Anything it can't handle is sent to OWNER_PHONE,
// and the owner's answer goes back to the client and is saved for next time.
import makeWASocket, { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, normalizeMessageContent, generateMessageIDV2, isWABusinessPlatform } from "baileys";
import pino from "pino";
import QRCode from "qrcode";
import fs from "fs";
import { t, ownerSummary, OWNER_HELP } from "./texts.js";

// Baileys' encryption layer console.logs a whole "Closing session: SessionEntry {…}"
// dump every time it re-keys with a contact. It is normal, it is not an error, and it
// buries the lines that matter in pm2 logs.
const _log = console.log;
console.log = (...a) => { if (typeof a[0] === "string" && /^Closing (session|open session|stale)/.test(a[0])) return; _log(...a); };

const { BACKEND_URL, WA_INTERNAL_KEY, OWNER_PHONE, AUTH_DIR = "./auth", GO_LIVE } = process.env;
if (!BACKEND_URL || !WA_INTERNAL_KEY || !OWNER_PHONE || !GO_LIVE) throw new Error("Set BACKEND_URL, WA_INTERNAL_KEY, OWNER_PHONE, GO_LIVE in .env");
const OWNER = OWNER_PHONE.replace(/\D/g, "");
const OWNER_JID = `${OWNER}@s.whatsapp.net`;
// Chats with any activity before this (IST midnight) are "legacy": never replied to, never followed up.
const GO_LIVE_MS = new Date(`${GO_LIVE}T00:00:00+05:30`).getTime();
if (Number.isNaN(GO_LIVE_MS)) throw new Error("GO_LIVE must look like 2026-09-21");
const FOLLOWUP_DAYS = Number(process.env.FOLLOWUP_DAYS || 2);  // quiet days before a nudge
const FOLLOWUP_MAX = Number(process.env.FOLLOWUP_MAX || 2);    // nudges per silence, then stop
const PAUSE_MIN = Number(process.env.PAUSE_MIN || 30);         // bot stays quiet after you type in a chat
const ACTIVE_HOURS = [10, 19];                                 // IST window for follow-ups/reminders
// Quiet hours: nothing goes out to a client between 1am and 6am IST. Someone messaging at
// 11pm is awake and gets an answer; someone woken at 3am is not a customer any more.
// Messages that arrive in the quiet window are held and answered from 6am.
const QUIET = [Number(process.env.QUIET_FROM || 1), Number(process.env.QUIET_TO || 6)];
const openNow = () => { const h = istHour(); return h < QUIET[0] || h >= QUIET[1]; };

// 90s for plain calls. The AI calls (/reply, /chats/reengage) get AI_TIMEOUT: the backend
// gives up on the model at 75s, so it always answers before we do — otherwise it would
// save a reply the client never got.
const AI_TIMEOUT = 120000;
async function api(method, path, body, timeoutMs = 90000) {
  const r = await fetch(`${BACKEND_URL.replace(/\/+$/, "")}/internal/wa${path}`, {
    method,
    headers: { "content-type": "application/json", "x-internal-key": WA_INTERNAL_KEY },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}
const pushStatus = (state, qr = null) => api("POST", "/bot-status", { state, qr }).catch(() => {});

// Per-chat scratch state: escalation rate limit, and pause while you type yourself.
const sessions = new Map();
const session = (k) => { if (!sessions.has(k)) sessions.set(k, { escalations: [] }); return sessions.get(k); };
const pausedUntil = new Map();
const paused = (jid) => (pausedUntil.get(jid) || 0) > Date.now();
const lastActive = new Map();   // jid -> when the client or the bot last spoke (see reengageTick)

let sock;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Every bot send goes through here so its echo (fromMe) isn't mistaken for you typing on the phone.
const botSent = new Set();
async function send(jid, content) {
  // id is registered BEFORE sending — the echo can arrive before sendMessage resolves.
  const messageId = generateMessageIDV2(sock.user?.id);
  botSent.add(messageId);
  if (botSent.size > 5000) botSent.delete(botSent.values().next().value);
  return sock.sendMessage(jid, content, { messageId });
}

// "typing…" and a pause that grows with the message: instant replies read as a bot.
// `stop`: checked after the pause, right before sending — the bot's own lines pass
// () => paused(jid), so if you step in while it "types", its line is dropped (returns
// null). Not built in: your approved answers go through here too and must still send.
async function say(jid, text, stop) {
  await sock.sendPresenceUpdate("composing", jid).catch(() => {});
  await sleep(Math.min(6000, 1200 + text.length * 35) + Math.random() * 1200);
  if (stop?.()) { sock.sendPresenceUpdate("paused", jid).catch(() => {}); return null; }
  const sent = await send(jid, { text });
  lastActive.set(jid, Date.now());
  if (jid !== OWNER_JID) {
    // last_out_at is what stops the 15-min pick-up firing again, so one retry if it fails.
    const out = () => api("POST", "/chats/event", { jid, dir: "out" });
    out().catch(() => out()).catch(() => {});
  }
  return sent;
}

const msOf = (ts) => 1000 * (ts && typeof ts === "object" ? (ts.toNumber ? ts.toNumber() : Number(ts.low)) : Number(ts || 0));
const istHour = () => Number(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata", hour: "numeric", hour12: false })) % 24;
const istDate = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
const istMidnightMs = () => new Date(`${istDate()}T00:00:00+05:30`).getTime();   // start of today, IST

// Phone digits of the sender. Newer WhatsApp chats can arrive as a privacy "@lid" id.
async function phoneOf(key) {
  const pn = (j) => j.split("@")[0].split(":")[0];
  for (const j of [key.remoteJidAlt, key.senderPn, key.remoteJid]) if (j?.endsWith("@s.whatsapp.net")) return pn(j);
  const mapped = await sock.signalRepository?.lidMapping?.getPNForLID?.(key.remoteJid)?.catch?.(() => null);
  return mapped ? pn(mapped) : "";
}

// Owner reply body:
//   "ok" / "haan" / "send"        -> send the draft as it is (and save it as an answer)
//   "once"                        -> send the draft, but DON'T save it: a one-off (a discount for this person)
//   "as is <text>"                -> send exactly these words, no drafting
//   "skip" | "=5" | "fix <text>"  -> as before
//   anything else                 -> your note (answer OR instruction) -> drafted for your OK
const parseReply = (s) =>
  /^(ok )?once$/i.test(s.trim()) ? { confirm: true, once: true }
  : /^(ok|okay|ok ji|haan|haan ji|yes|y|send|bhej do|theek hai|sahi hai|👍)$/i.test(s.trim()) ? { confirm: true }
  : /^skip$/i.test(s) ? { skip: true }
  : /^=\s*\d+$/.test(s) ? { faq_id: +s.match(/\d+/)[0] }
  : /^fix\s+/i.test(s) ? { text: s.replace(/^fix\s+/i, ""), fix: true }
  : /^as is\s+/i.test(s) ? { text: s.replace(/^as is\s+/i, ""), raw: true }
  : { text: s };

async function handleOwner(jid, text, quoted) {
  const onOff = text.match(/^(on|off)\s+([\d\s+]{10,})$/i);
  if (onOff) {
    const status = onOff[1].toLowerCase() === "on" ? "active" : "off";
    const num = onOff[2].trim();
    // A chat can live under a private "@lid" id with no phone saved on it, so the number
    // alone won't find it: send the number's LID too (null when WhatsApp won't say).
    // 91 + last 10 digits, the same way the backend builds a number's jid.
    const pnJid = `91${num.replace(/\D/g, "").slice(-10)}@s.whatsapp.net`;
    const lid = await sock.signalRepository?.lidMapping?.getLIDForPN?.(pnJid)?.catch?.(() => null);
    const r = await api("POST", "/chats/set", { phone: num, jids: [pnJid, lid].filter(Boolean), status }).catch((e) => ({ error: e.message }));
    return send(jid, { text: r.error ? `⚠️ ${r.error}`
      : r.created ? `✅ Bot on for ${num} — no chat with this number was on record, so a new one was started` +
          (lid ? "" : `. If they've written before from a private id, send *on ${num}* again after their next message`)
      : r.updated ? `✅ Bot ${onOff[1].toLowerCase()} for ${num} (${r.updated} chat${r.updated > 1 ? "s" : ""} updated)`
      : `No chat found for ${num}` });
  }
  if (/^(ping|status)$/i.test(text.trim())) {
    const up = Math.round(process.uptime() / 60);
    const ok = await api("GET", "/questions/stale?hours=999999").then(() => "reachable").catch((e) => `UNREACHABLE (${e.message})`);
    return send(jid, { text: `✅ Bot alive · connected · up ${up} min\nBackend: ${ok}` });
  }
  // demo 98xxxxxxxx Shop Name — build someone a demo store yourself, without the assistant.
  const demo = text.match(/^demo\s+([\d\s+]{10,15}?)\s+(.+)$/i);
  if (demo) {
    const r = await api("POST", "/demo/create", { phone: demo[1], store_name: demo[2].trim(), name: demo[2].trim() })
      .catch((e) => ({ error: e.message }));
    return send(jid, { text: r.error ? `⚠️ ${r.error}`
      : `🏪 ${r.reused ? "Already live" : "Demo store built"}: ${r.url}\n${r.products || 0} source(s) of products · runs ${r.days} days` });
  }
  const outcome = text.match(/^(won|lost|sold|converted)\s+([\d\s+]{10,})$/i);
  if (outcome) {
    const kind = /^(won|sold|converted)$/i.test(outcome[1]) ? "won" : "lost";
    const r = await api("POST", "/leads/outcome", { phone: outcome[2], outcome: kind }).catch((e) => ({ error: e.message }));
    return send(jid, { text: r.error ? `⚠️ ${r.error}`
      : r.updated ? `${kind === "won" ? "🏆" : "📕"} Marked ${kind}: ${r.lead?.store_name || r.lead?.name || outcome[2].trim()}`
      : `No lead found for ${outcome[2].trim()}` });
  }
  const reset = text.match(/^reset\s+([\d\s+]{10,})$/i);
  if (reset) {
    const r = await api("POST", "/forget", { phone: reset[1] }).catch((e) => ({ error: e.message }));
    return send(jid, { text: r.error ? `⚠️ ${r.error}` : `🧹 Chat memory cleared for ${reset[1].trim()} — next message starts fresh` });
  }
  const tag = text.match(/^#(\d+)\s*([\s\S]*)$/);
  let body;
  if (tag) body = { id: +tag[1], ...parseReply(tag[2].trim()) };
  else if (quoted && text) body = { owner_msg_id: quoted, ...parseReply(text) };
  else if (text && parseReply(text).confirm) body = parseReply(text);  // plain "ok" / "once" -> the latest draft
  else return send(jid, { text: OWNER_HELP });
  try {
    const r = await api("POST", "/answer", body);
    const q = r.question;

    // Draft: show it to the owner and wait for their go-ahead.
    if (r.drafted) {
      const preview = await send(jid, {
        text: `📝 Draft for #${q.id} → ${q.name || "+" + q.phone}\n\n${r.draft}\n\n` +
              `Reply *ok* to send (and save it for next time) · *once* to send without saving · ` +
              `type a correction to redo it · *#${q.id} as is <text>* to send your exact words`,
      });
      if (preview?.key?.id) await api("PATCH", `/questions/${q.id}`, { draft_msg_id: preview.key.id }).catch(() => {});
      return;
    }

    if (r.answer && !r.fixed) {
      await say(q.jid, r.answer);
      await api("POST", "/sent", { jid: q.jid, text: r.answer }).catch(() => {});
    }
    await send(jid, { text: r.fixed ? `✏️ #${q.id} saved (answer ${r.faq_id}) — not re-sent to the client`
      : r.answer ? `✅ #${q.id} sent to ${q.name || "+" + q.phone}${body.once ? " — not saved as an answer" : ""}`
      : `⏭ #${q.id} skipped` });
  } catch (e) {
    await send(jid, { text: `⚠️ ${e.message}` });
  }
}

// You typed in a chat from the bot phone. Before the client has ever replied, that's
// your starter message: the chat becomes the bot's to carry on. Once the client is
// talking, it means you've stepped in, so the bot keeps quiet for PAUSE_MIN.
async function handleManualOut(jid, text) {
  const r = await api("POST", "/chats/event", { jid, dir: "out" });
  if (text) api("POST", "/sent", { jid, text }).catch(() => {});   // your words are part of the conversation
  if (r.chat.status === "active" && r.chat.last_in_at) pausedUntil.set(jid, Date.now() + PAUSE_MIN * 60e3);
}

const OPT_OUT = /^(stop|unsubscribe|band karo|mat bhejo|message mat karo|बंद करो|मत भेजो)$/i;
const handled = new Set();   // message ids already processed (WhatsApp re-delivers on reconnect)

async function handle(m) {
  const jid = m.key.remoteJid;
  if (!jid || /@(g\.us|broadcast|newsletter)$/.test(jid)) return;
  // Answer anything from today (IST): on a restart, WhatsApp replays the day's backlog
  // as "append" and we still reply to it. Nothing before GO_LIVE, nothing before today.
  const at = msOf(m.messageTimestamp);
  if (at < GO_LIVE_MS || at < istMidnightMs()) return;
  const c = normalizeMessageContent(m.message);
  if (!c || c.reactionMessage || c.protocolMessage) return;
  // WhatsApp re-delivers on reconnect. Every message goes through this, owner commands
  // too: a replayed bare "ok" would otherwise send whatever draft is newest by then.
  // Marked only once there IS content: a message that failed to decrypt first arrives as
  // an empty stub, and the real one follows later under the same id — it must get through.
  if (handled.has(m.key.id)) return;
  handled.add(m.key.id);
  if (handled.size > 3000) handled.delete(handled.values().next().value);

  const phone = await phoneOf(m.key);
  const text = (c.conversation || c.extendedTextMessage?.text || c.imageMessage?.caption ||
    c.videoMessage?.caption || c.documentMessage?.caption || "").trim();

  if (m.key.fromMe) {
    if (botSent.has(m.key.id) || jid === OWNER_JID || phone === OWNER) return;
    return handleManualOut(jid, text);
  }
  if (c.stickerMessage) return;
  if (phone && phone === OWNER) return handleOwner(jid, text, c.extendedTextMessage?.contextInfo?.stanzaId);

  const kind = c.audioMessage ? "voice note" : c.imageMessage ? "image" : c.videoMessage ? "video" : c.documentMessage ? "document" : null;
  if (!text && !kind) return;

  // Is this chat the bot's? Legacy (pre-GO_LIVE) and muted chats are left to you.
  const { chat } = await api("POST", "/chats/event", { jid, phone, dir: "in" });
  if (chat.status !== "active") return;
  // Don't re-answer something we already replied to (ids are deduped at the top). The
  // timestamp check only drops CLEARLY stale backlog (5+ min older than our last reply) —
  // a tight comparison silences the chat whenever the sender's phone clock runs behind the server's.
  if (chat.last_out_at && at < new Date(chat.last_out_at).getTime() - 5 * 60e3) return;
  if (paused(jid)) return;

  const name = m.pushName || "";
  const lang = chat.lang || "hinglish";

  if (OPT_OUT.test(text)) {
    await api("POST", "/chats/set", { jid: chat.jid, opted_out: true });
    return say(jid, t(lang).optedOut);
  }

  // Don't answer the first line of someone who is still typing the rest of their
  // thought: collect what they send, then reply once to all of it.
  queue({ jid, phone, name, lang, text, kind, msg: m });
  sock.presenceSubscribe(jid).catch(() => {});   // so "composing" reaches us and extends the wait
}

// ---- wait for them to finish -------------------------------------------------
const WAIT_MS = Number(process.env.REPLY_WAIT_MS || 3500);          // quiet time before replying
const TYPING_STOP_MS = Number(process.env.REPLY_TYPING_STOP_MS || 1200); // they stopped typing -> go
const MAX_WAIT_MS = Number(process.env.REPLY_MAX_WAIT_MS || 60000); // ...but never hold longer than this
const pending = new Map();   // jid -> { first, timer, parts[], media[], ctx }

function queue(ctx) {
  let p = pending.get(ctx.jid);
  if (!p) { p = { first: Date.now(), parts: [], media: [], ctx }; pending.set(ctx.jid, p); }
  lastActive.set(ctx.jid, Date.now());
  p.ctx = { ...ctx, kind: ctx.kind || p.ctx.kind };
  if (ctx.text) p.parts.push(ctx.text);
  if (ctx.kind) p.media.push(ctx.msg);   // every photo/voice note, not just the last
  hold(ctx.jid);
}

// One thing at a time per chat. While a reply (or a pick-up line) is being worked on,
// new messages keep collecting in `pending` and go out as one batch right after it —
// never two answers crossing each other, never an answer built on stale history.
const busy = new Set();
async function inChat(jid, fn) {
  busy.add(jid);
  try { return await fn(); }
  finally { busy.delete(jid); if (pending.has(jid)) hold(jid); }
}

// (re)start the timer. wait=WAIT_MS while we're unsure, or TYPING_STOP_MS the moment
// WhatsApp tells us they've stopped typing — no point sitting there waiting then.
function hold(jid, wait = WAIT_MS) {
  const p = pending.get(jid);
  if (!p) return;
  clearTimeout(p.timer);
  const left = p.first + MAX_WAIT_MS - Date.now();
  p.timer = setTimeout(() => flush(jid), Math.max(600, Math.min(wait, left)));
}

async function flush(jid) {
  const p = pending.get(jid);
  if (!p || busy.has(jid)) return;   // busy: inChat() flushes this batch when the current one is done
  // Outside business hours the batch is left in pending: replying at 1am reads as a machine,
  // and openHours() re-flushes everything waiting at the start of the next working day.
  if (!openNow()) return;
  pending.delete(jid);
  if (paused(jid)) return;           // you stepped in while they were still typing
  return inChat(jid, () => reply(jid, p));
}

async function reply(jid, p) {
  const { phone, name, lang, kind } = p.ctx;
  const media = p.media;
  const text = p.parts.join("\n").trim();          // everything they said, as one message
  const s = session(phone || jid);

  const escalate = async (question, holding, withMedia = false) => {
    if (paused(jid)) return;         // you're already in this chat — nothing to hand over
    const now = Date.now();
    s.escalations = s.escalations.filter((x) => now - x < 30 * 60e3);
    // Too many already waiting on the owner: stop pinging their phone, but still record
    // the question (portal, report, 15-min pick-up) and forward the files — they exist
    // nowhere else. NEVER leave anything silently dropped.
    const quiet = s.escalations.length >= 6;
    if (!quiet) s.escalations.push(now);
    const files = withMedia ? media : [];
    const { id, duplicate } = await api("POST", "/questions", { phone, jid, name, text: question, lang });
    // duplicate = this chat already asked the same thing and it's still waiting: the
    // owner has it (the backend restarts its pick-up clock), so no second ping.
    let head = null;
    if (!duplicate && !quiet) {
      const contact = await api("GET", `/contact/${phone || "0"}`).catch(() => null);
      head = await send(OWNER_JID, { text: ownerSummary({ id, name, phone, text: question, lang, contact, kind: files.length ? kind : null }) });
    } else if (files.length) {
      // Files still need a label, or the owner gets pictures from nobody.
      head = await send(OWNER_JID, { text: `📎 #${id} · ${name || "+" + phone} sent ${files.length} ${files.length > 1 ? "files" : kind}` });
    }
    for (const f of files) await send(OWNER_JID, { forward: f }).catch(() => {});
    if (head && !duplicate) await api("PATCH", `/questions/${id}`, { owner_msg_id: head.key.id });
    if (holding && (!quiet || now - (s.lastHold || 0) > 10 * 60e3)) {
      s.lastHold = now;
      if (await say(jid, holding, () => paused(jid))) await api("POST", "/sent", { jid, text: holding }).catch(() => {});
    }
  };

  try {
    if (kind) return await escalate(text || `[${kind}]`, t(lang).media, true);
    if (!text) return;
    const r = await api("POST", "/reply", { text, phone, jid, name }, AI_TIMEOUT);
    markInterest(jid, r.score);
    if (paused(jid)) return;         // you typed while the answer was being written — yours wins
    if (r.reply && !r.escalate) {
      // You can still step in during the "typing…" pause: then nothing goes out, and
      // /sent isn't called, so the chat memory never holds a line the client didn't get.
      if (!(await say(jid, r.reply, () => paused(jid)))) return;
      await api("POST", "/sent", { jid, text: r.reply }).catch(() => {});
      // Product photos from our catalogue — captions carry details, never prices.
      for (const p of r.products || []) {
        if (paused(jid)) break;
        await send(jid, { image: { url: p.image }, caption: p.caption }).catch((e) => console.error("img", e.message));
        await sleep(700);
      }
      return;
    }
    // No "let me check with the team" — the chat simply pauses while the owner answers.
    // If they haven't in REENGAGE_MIN, reengageTick() picks the talk back up.
    await escalate(text, null);
  } catch (e) {
    // Never show the client an error. Hand it to the owner quietly.
    console.error("flush", e);
    await escalate(text || "[failed to process]", null).catch(() => {});
  }
}

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  // Legacy marking only for the history sync of a brand-new QR link, never on later restarts.
  // Baileys reconnects once right after the scan and the history lands on THAT connection,
  // so the link time is saved to disk and history is accepted for 30 min after it.
  const linkedFile = `${AUTH_DIR}/linked_at`;
  if (!state.creds.me && !fs.existsSync(linkedFile)) fs.writeFileSync(linkedFile, String(Date.now()));
  const freshLink = fs.existsSync(linkedFile) && Date.now() - Number(fs.readFileSync(linkedFile, "utf8")) < 30 * 60e3;
  const { version } = await fetchLatestBaileysVersion();
  sock = makeWASocket({ version, auth: state, logger: pino({ level: "warn" }), markOnlineOnConnect: false });
  sock.ev.on("creds.update", saveCreds);
  sock.ev.on("connection.update", async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      console.log("Scan with the BOT phone: WhatsApp → Linked devices → Link a device\n" + await QRCode.toString(qr, { type: "terminal", small: true }));
      pushStatus("qr", qr);
    }
    if (connection === "open") { console.log("WhatsApp connected"); pushStatus("connected"); }
    if (connection === "close") {
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code === DisconnectReason.loggedOut) {
        console.log("Logged out — clearing session, a new QR will follow");
        fs.rmSync(AUTH_DIR, { recursive: true, force: true });
        pushStatus("logged_out");
      } else pushStatus("reconnecting");
      setTimeout(start, 3000);
    }
  });
  // "append" too: messages that arrived while the bot was offline. handle() drops anything >12h old.
  sock.ev.on("messages.upsert", ({ messages, type }) => {
    if (type !== "notify" && type !== "append") return;
    // Log and stay silent: flush() owns the reply path and its own fallback.
    for (const m of messages) handle(m).catch((e) => console.error("handle", e));
  });
  // Typing -> keep waiting (they have more to say). Stopped typing -> answer almost at once.
  sock.ev.on("presence.update", ({ id, presences }) => {
    if (!pending.has(id)) return;
    const states = Object.values(presences || {}).map((p) => p?.lastKnownPresence);
    if (states.some((s) => s === "composing" || s === "recording")) hold(id, WAIT_MS);
    else if (states.length) hold(id, TYPING_STOP_MS);
  });
  if (freshLink) sock.ev.on("messaging-history.set", ({ chats, messages }) => markLegacy(chats, messages).catch((e) => console.error("legacy", e.message)));
}

// History sync (arrives right after linking): every chat with activity before GO_LIVE
// is recorded as legacy, so the bot never replies to or follows up your old chats.
async function markLegacy(chats = [], messages = []) {
  const oldest = new Map();
  for (const m of messages) {
    const j = m.key?.remoteJid, at = msOf(m.messageTimestamp);
    if (j && at && at < (oldest.get(j) ?? Infinity)) oldest.set(j, at);
  }
  const out = [];
  for (const c of chats) {
    if (!c.id || /@(g\.us|broadcast|newsletter)$/.test(c.id)) continue;
    const first = oldest.get(c.id) ?? msOf(c.conversationTimestamp);
    if (first && first >= GO_LIVE_MS) continue;
    const phone = (c.pnJid || (c.id.endsWith("@s.whatsapp.net") ? c.id : "")).split("@")[0];
    for (const jid of new Set([c.id, c.pnJid, c.lidJid].filter(Boolean))) out.push({ jid, phone });
  }
  if (out.length) {
    await api("POST", "/chats/legacy", { chats: out });
    console.log(`marked ${out.length} old chat ids as legacy`);
  }
}

// ---- "interested" labels on the bot phone -------------------------------------
// Hot and warm leads get a WhatsApp label, so you can filter them on the phone.
// Labels only exist on WhatsApp BUSINESS accounts; on a normal account labelling switches
// itself off — the portal's Leads tab still has them all.
const LABELS = {
  hot:  { id: "kartify_hot",  name: "🔥 Hot lead",   color: 1 },
  warm: { id: "kartify_warm", name: "🙂 Interested", color: 4 },
};
let labelsOn = null;           // null = not settled yet, true/false once it is
let labelsRetryAt = 0;
const labelled = new Map();    // jid -> score already applied
async function ensureLabels() {
  if (labelsOn !== null) return labelsOn;
  if (Date.now() < labelsRetryAt) return false;
  // The phone's app is known from pairing: a normal WhatsApp account is off for good.
  const platform = sock.authState?.creds?.platform;
  if (platform && !isWABusinessPlatform(platform)) {
    console.log("labels off (needs WhatsApp Business on the bot number)");
    return (labelsOn = false);
  }
  // Anything else (app-state keys not synced yet right after linking, a timeout, a
  // dropped connection) is temporary: try again in an hour.
  try {
    for (const l of Object.values(LABELS)) await sock.addLabel(OWNER_JID, { id: l.id, name: l.name, color: l.color });
    labelsOn = true;
  } catch (e) {
    labelsRetryAt = Date.now() + 60 * 60e3;
    console.log("labels failed, retrying in an hour:", e.message);
  }
  return !!labelsOn;
}
async function markInterest(jid, score) {
  if (!LABELS[score] || labelled.get(jid) === score) return;
  if (!(await ensureLabels())) return;
  try {
    const old = labelled.get(jid);
    if (old && LABELS[old]) await sock.removeChatLabel(jid, LABELS[old].id).catch(() => {});
    await sock.addChatLabel(jid, LABELS[score].id);
    labelled.set(jid, score);
  } catch (e) { console.error("label", e.message); }
}

// ---- the clock ---------------------------------------------------------------
// Every 5 min:
//   · pick up chats left hanging on the owner for REENGAGE_MIN (8am–11pm IST — someone
//     who just messaged is awake, and silence is what loses them)
//   · once a day after REPORT_HOUR, send the owner the day's report
// Every 30 min, 10:00–19:00 IST: follow-ups and the morning reminders, as before.
const REENGAGE_MIN = Number(process.env.REENGAGE_MIN || 15);
const REPORT_HOUR = Number(process.env.REPORT_HOUR || 20);
let lastSlowTick = 0;

// Once-a-day sends keep their date in a file next to linked_at: marked only after the
// send went through (a failed one is retried next tick), and a restart doesn't repeat it.
const sentToday = (name) => { try { return fs.readFileSync(`${AUTH_DIR}/${name}`, "utf8") === istDate(); } catch { return false; } };
const markSentToday = (name) => { try { fs.writeFileSync(`${AUTH_DIR}/${name}`, istDate()); } catch (e) { console.error(name, e.message); } };

// Messages you sent from the portal's Leads screen. The backend queues them (it can't reach
// WhatsApp itself) and this delivers them from the bot number, so the reply comes back into
// the same chat and the assistant carries on from there.
async function outboxTick() {
  if (!sock?.user || !openNow()) return;   // queued at 2am -> goes out at 6am
  const { messages } = await api("GET", "/outbox");
  for (const m of messages || []) {
    try {
      await say(m.jid, m.text);
      await api("POST", "/sent", { jid: m.jid, text: m.text }).catch(() => {});
      await api("POST", `/outbox/${m.id}/done`, { ok: true });
      console.log(`[wa-outbox] sent to ${m.phone || m.jid}`);
    } catch (e) {
      console.error("[wa-outbox]", e.message);
      await api("POST", `/outbox/${m.id}/done`, { ok: false, error: e.message }).catch(() => {});
    }
    await sleep(2000 + Math.random() * 2000);
  }
}
setInterval(() => outboxTick().catch((e) => console.error("outbox", e.message)), 20e3);

// Messages that came in overnight: answer them when the day opens, oldest first.
function flushHeld() {
  if (!openNow()) return;
  for (const jid of [...pending.keys()]) flush(jid).catch((e) => console.error("held", e.message));
}

async function reengageTick() {
  if (!openNow()) return;
  const asked = Date.now();
  const { chats } = await api("GET", `/chats/reengage?mins=${REENGAGE_MIN}`, undefined, AI_TIMEOUT);
  for (const c of chats) {
    // They wrote again (or you did, or we already answered) while the line was being
    // made: that conversation is the pick-up, a second message on top is one too many.
    if (pending.has(c.jid) || busy.has(c.jid) || paused(c.jid) || (lastActive.get(c.jid) || 0) > asked) continue;
    // say() moves last_out_at, so this chat won't be picked again; /sent puts the line
    // in the chat memory only now that the client actually has it.
    await inChat(c.jid, async () => {
      if (await say(c.jid, c.text, () => paused(c.jid))) await api("POST", "/sent", { jid: c.jid, text: c.text }).catch(() => {});
    }).catch((e) => console.error("reengage", c.jid, e.message));
    await sleep(3000 + Math.random() * 4000);
  }
}

async function reportTick() {
  if (istHour() < REPORT_HOUR || sentToday("last_report")) return;
  const r = await api("GET", "/report/today");
  const n = (x) => x ?? 0;
  const byScore = Object.fromEntries((r.leads || []).map((l) => [l.score, l.n]));
  const lines = [
    `📊 *Today's WhatsApp report* — ${istDate()}`,
    "",
    // "incoming" counts turns, not messages: whatever a client sent before we answered is
    // one batch = one turn, and photos/voice notes (handed to you, not answered) aren't in it.
    `💬 ${n(r.msgs?.chats)} chats · ${n(r.msgs?.incoming)} conversation turns in · ${n(r.msgs?.sent)} replies out`,
    `🆕 ${n(r.chats?.new_chats)} new chats (${n(r.chats?.you_started)} started by you)`,
    `🤖 ${n(r.qs?.answered_by_ai)} answered by the assistant · 👤 ${n(r.qs?.answered_by_you)} by you · ⏳ ${n(r.qs?.waiting_on_you)} waiting on you`,
    `🎯 Leads: 🔥 ${n(byScore.hot)} hot · 🙂 ${n(byScore.warm)} warm · ${n(byScore.cold)} cold`,
  ];
  const f = r.funnel || {};
  lines.push(`📈 Demo offered ${n(f.demo_offered)} · said yes ${n(f.demo_yes)} · ready to build ${n(f.ready_to_build)}`);
  // Demo stores: who has one running, how long is left, and whether they've verified/paid.
  const { demos } = await api("GET", "/demo/live").catch(() => ({ demos: [] }));
  const live = (demos || []).filter((d) => d.status === "active");
  if (live.length) {
    lines.push("", `*Demo stores running (${live.length}):*`);
    for (const d of live.slice(0, 10)) {
      const left = Math.max(0, Math.ceil((new Date(d.demo_expires_at) - Date.now()) / 864e5));
      lines.push(`🏪 ${d.demo_slug} — ${left} day(s) left · ${d.name || "+" + d.phone}` +
        `\n   ${d.has_plan ? "💰 plan taken" : d.mobile_verified ? "📱 verified, no plan yet" : "⏳ not verified yet"}`);
    }
  }
  lines.push(`✅ Won today ${n(f.won_today)} · lost ${n(f.lost_today)} · won in total ${n(f.won_total)}`);

  // Chat by chat: what they told us, how far it got, and what is still missing.
  const STAGE = { ready: "✅ ready to build", details: "📝 giving details", demo_yes: "👍 wants the demo",
    demo_offered: "🎬 demo offered", talking: "💬 talking", new: "🆕 new", not_interested: "❌ not interested" };
  if (r.perChat?.length) {
    lines.push("", "*Every chat today:*");
    for (const c of r.perChat) {
      const who = c.name || c.store_name || c.business || "+" + c.phone;
      const about = [c.business && c.business !== who ? c.business : "", c.sells, c.city,
        c.shops && `${c.shops} shop`, c.online_already && `online: ${c.online_already}`].filter(Boolean).join(" · ");
      const got = [c.store_name && `store "${c.store_name}"`, c.whatsapp_for_orders && `order no. ${c.whatsapp_for_orders}`,
        c.supplier_links && `supplier ${c.supplier_links}`, c.own_domain && `domain ${c.own_domain}`,
        c.upi_id && "UPI given", c.plan_interest && `likes ${c.plan_interest}`].filter(Boolean).join(" · ");
      lines.push(
        `${c.score === "hot" ? "🔥" : c.score === "warm" ? "🙂" : "⚪"} *${who}* — ${STAGE[c.stage] || c.stage}` +
        `${c.outcome ? ` · ${c.outcome === "won" ? "🏆 WON" : "lost"}` : ""}` +
        `\n   ${c.msgs || 0} msgs · wa.me/${c.phone}` +
        (about ? `\n   About: ${about}` : "") +
        (got ? `\n   Got: ${got}` : "") +
        (c.score_reason ? `\n   ${c.score_reason}` : "") +
        (c.last_from_them ? `\n   Last from them: "${String(c.last_from_them).slice(0, 60)}"` : ""));
    }
    lines.push("", "Mark a result:  won 98xxxxxxxx  ·  lost 98xxxxxxxx");
  }
  if (r.pending?.length) {
    lines.push("", "*Still waiting on you:*");
    for (const q of r.pending) lines.push(`#${q.id} · ${q.name || "+" + q.phone}: "${String(q.text).slice(0, 70)}"`);
    lines.push("Reply  #id <answer>  or  #id skip");
  }
  await send(OWNER_JID, { text: lines.join("\n") });
  markSentToday("last_report");
}

async function tick() {
  if (!sock?.user) return;
  flushHeld();   // anything that came in during the quiet hours
  // Demo stores past their 7 days switch themselves off (nothing is deleted).
  api("POST", "/demo/sweep").catch((e) => console.error("demo sweep", e.message));
  await reengageTick().catch((e) => console.error("reengage", e.message));
  await reportTick().catch((e) => console.error("report", e.message));
  if (Date.now() - lastSlowTick < 30 * 60e3) return;
  lastSlowTick = Date.now();
  await slowTick();
}

async function slowTick() {
  const h = istHour();
  if (h < ACTIVE_HOURS[0] || h >= ACTIVE_HOURS[1]) return;

  if (!sentToday("last_reminder")) {
    const { questions } = await api("GET", "/questions/stale?hours=24");
    if (questions.length) {
      await send(OWNER_JID, { text: `⏰ ${questions.length} question(s) still waiting for you:\n\n` +
        questions.map((q) => `#${q.id} · ${q.name || "+" + q.phone}: "${q.text.slice(0, 80)}"`).join("\n") +
        `\n\nReply  #id <answer>  or  #id skip` });
    }

    // Same daily slot: who the assistant talked to and how promising they look.
    const { leads } = await api("GET", "/leads/new?hours=24").catch(() => ({ leads: [] }));
    const hot = leads.filter((l) => l.score !== "cold");
    if (hot.length) {
      await send(OWNER_JID, { text: `🔥 ${hot.length} lead(s) from yesterday:\n\n` +
        hot.map((l) => `${l.score === "hot" ? "🔥" : "🙂"} ${l.name || "+" + l.phone} · ${[l.business, l.city, l.sells, l.shops && l.shops + " shop"].filter(Boolean).join(" · ") || "—"}\n   +${l.phone} — ${l.score_reason || ""}`).join("\n") });
    }
    markSentToday("last_reminder");
  }

  const { chats } = await api("GET", `/chats/due?days=${FOLLOWUP_DAYS}&max=${FOLLOWUP_MAX}`);
  for (const c of chats) {
    const msgs = t(c.lang).followups;
    const text = msgs[Math.min(c.followups, msgs.length - 1)];
    await send(c.jid, { text });
    await api("POST", "/chats/followed-up", { jid: c.jid });
    await api("POST", "/sent", { jid: c.jid, text }).catch(() => {});
    await sleep(20e3 + Math.random() * 40e3); // spread out — a burst of identical texts looks like spam
  }
}
setInterval(() => tick().catch((e) => console.error("tick", e.message)), 5 * 60e3);

start();
