// WhatsApp assistant (Baileys linked device). No menus, no greeting script, no
// language question: every client message goes to the backend's /internal/wa/reply,
// which holds the conversation. Anything it can't handle is sent to OWNER_PHONE,
// and the owner's answer goes back to the client and is saved for next time.
import makeWASocket, { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, normalizeMessageContent, generateMessageIDV2 } from "baileys";
import pino from "pino";
import QRCode from "qrcode";
import fs from "fs";
import { t, ownerSummary, OWNER_HELP } from "./texts.js";

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

async function api(method, path, body) {
  const r = await fetch(`${BACKEND_URL.replace(/\/+$/, "")}/internal/wa${path}`, {
    method,
    headers: { "content-type": "application/json", "x-internal-key": WA_INTERNAL_KEY },
    body: body ? JSON.stringify(body) : undefined,
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
async function say(jid, text) {
  await sock.sendPresenceUpdate("composing", jid).catch(() => {});
  await sleep(Math.min(6000, 1200 + text.length * 35) + Math.random() * 1200);
  const sent = await send(jid, { text });
  if (jid !== OWNER_JID) api("POST", "/chats/event", { jid, dir: "out" }).catch(() => {});
  return sent;
}

const msOf = (ts) => 1000 * (ts && typeof ts === "object" ? (ts.toNumber ? ts.toNumber() : Number(ts.low)) : Number(ts || 0));
const istHour = () => Number(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata", hour: "numeric", hour12: false })) % 24;
const istDate = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });

// Phone digits of the sender. Newer WhatsApp chats can arrive as a privacy "@lid" id.
async function phoneOf(key) {
  const pn = (j) => j.split("@")[0].split(":")[0];
  for (const j of [key.remoteJidAlt, key.senderPn, key.remoteJid]) if (j?.endsWith("@s.whatsapp.net")) return pn(j);
  const mapped = await sock.signalRepository?.lidMapping?.getPNForLID?.(key.remoteJid)?.catch?.(() => null);
  return mapped ? pn(mapped) : "";
}

// Owner reply body: "skip" | "=5" | "fix <better wording>" | answer text
const parseReply = (s) =>
  /^skip$/i.test(s) ? { skip: true }
  : /^=\s*\d+$/.test(s) ? { faq_id: +s.match(/\d+/)[0] }
  : /^fix\s+/i.test(s) ? { text: s.replace(/^fix\s+/i, ""), fix: true }
  : { text: s };

async function handleOwner(jid, text, quoted) {
  const onOff = text.match(/^(on|off)\s+([\d\s+]{10,})$/i);
  if (onOff) {
    const status = onOff[1].toLowerCase() === "on" ? "active" : "off";
    const r = await api("POST", "/chats/set", { phone: onOff[2], status }).catch((e) => ({ error: e.message }));
    return send(jid, { text: r.error ? `⚠️ ${r.error}` : r.updated ? `✅ Bot ${onOff[1].toLowerCase()} for ${onOff[2].trim()}` : `No chat found for ${onOff[2].trim()}` });
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
  else return send(jid, { text: OWNER_HELP });
  try {
    const r = await api("POST", "/answer", body);
    const q = r.question;
    // Sent word for word as the owner typed it — never rephrased.
    if (r.answer && !r.fixed) {
      await say(q.jid, r.answer);
      await api("POST", "/sent", { jid: q.jid, text: r.answer }).catch(() => {});
    }
    await send(jid, { text: r.fixed ? `✏️ #${q.id} saved (answer ${r.faq_id}) — not re-sent to the client`
      : r.answer ? `✅ #${q.id} sent to ${q.name || "+" + q.phone}`
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

async function handle(m) {
  const jid = m.key.remoteJid;
  if (!jid || /@(g\.us|broadcast|newsletter)$/.test(jid)) return;
  // Only live traffic: nothing from before GO_LIVE, nothing replayed from >12h ago after downtime.
  const at = msOf(m.messageTimestamp);
  if (at < GO_LIVE_MS || at < Date.now() - 12 * 3600e3) return;
  const c = normalizeMessageContent(m.message);
  if (!c || c.reactionMessage || c.protocolMessage) return;

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
  if ((pausedUntil.get(jid) || 0) > Date.now()) return;

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
const WAIT_MS = Number(process.env.REPLY_WAIT_MS || 8000);        // quiet time before replying
const MAX_WAIT_MS = Number(process.env.REPLY_MAX_WAIT_MS || 60000); // ...but never hold longer than this
const pending = new Map();   // jid -> { first, timer, parts[], ctx }

function queue(ctx) {
  let p = pending.get(ctx.jid);
  if (!p) { p = { first: Date.now(), parts: [], ctx }; pending.set(ctx.jid, p); }
  p.ctx = { ...ctx, msg: ctx.kind ? ctx.msg : p.ctx.msg, kind: ctx.kind || p.ctx.kind };
  if (ctx.text) p.parts.push(ctx.text);
  hold(ctx.jid);
}

// (re)start the quiet timer — called again on every new message and while they type
function hold(jid) {
  const p = pending.get(jid);
  if (!p) return;
  clearTimeout(p.timer);
  const left = p.first + MAX_WAIT_MS - Date.now();
  p.timer = setTimeout(() => flush(jid), Math.max(1000, Math.min(WAIT_MS, left)));
}

async function flush(jid) {
  const p = pending.get(jid);
  if (!p) return;
  pending.delete(jid);
  const { phone, name, lang, kind, msg } = p.ctx;
  const text = p.parts.join("\n").trim();          // everything they said, as one message
  const s = session(phone || jid);

  const escalate = async (question, holding, withMedia = false) => {
    const now = Date.now();
    s.escalations = s.escalations.filter((x) => now - x < 30 * 60e3);
    if (s.escalations.length >= 4) return;            // already waiting on the owner; stay quiet
    s.escalations.push(now);
    const { id } = await api("POST", "/questions", { phone, jid, name, text: question, lang });
    const contact = await api("GET", `/contact/${phone || "0"}`).catch(() => null);
    const sent = await send(OWNER_JID, { text: ownerSummary({ id, name, phone, text: question, lang, contact, kind: withMedia ? kind : null }) });
    if (withMedia && msg) await send(OWNER_JID, { forward: msg }).catch(() => {});
    await api("PATCH", `/questions/${id}`, { owner_msg_id: sent.key.id });
    if (holding) { await say(jid, holding); await api("POST", "/sent", { jid, text: holding }).catch(() => {}); }
  };

  try {
    if (kind) return await escalate(text || `[${kind}]`, t(lang).media, true);
    if (!text) return;
    const r = await api("POST", "/reply", { text, phone, jid, name });
    if (r.reply && !r.escalate) {
      await say(jid, r.reply);
      // Product photos from our catalogue — captions carry details, never prices.
      for (const p of r.products || []) {
        await send(jid, { image: { url: p.image }, caption: p.caption }).catch((e) => console.error("img", e.message));
        await sleep(700);
      }
      return;
    }
    await escalate(text, r.reply || t(lang).checking);
  } catch (e) {
    console.error("flush", e);
    await send(jid, { text: t(lang).error }).catch(() => {});
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
    for (const m of messages) handle(m).catch((e) => {
      console.error("handle", e);
      if (!m.key.fromMe) send(m.key.remoteJid, { text: t().error }).catch(() => {});
    });
  });
  // They're still typing (or recording) — keep waiting instead of answering half a thought.
  sock.ev.on("presence.update", ({ id, presences }) => {
    if (!pending.has(id)) return;
    if (Object.values(presences || {}).some((p) => p?.lastKnownPresence === "composing" || p?.lastKnownPresence === "recording")) hold(id);
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

// Every 30 min, 10:00–19:00 IST: nudge chats that went quiet after our last message,
// and once a day remind the owner of questions they haven't answered.
let lastReminder = "";
async function tick() {
  const h = istHour();
  if (!sock?.user || h < ACTIVE_HOURS[0] || h >= ACTIVE_HOURS[1]) return;

  if (lastReminder !== istDate()) {
    lastReminder = istDate();
    const { questions } = await api("GET", "/questions/stale?hours=24");
    if (questions.length) {
      await send(OWNER_JID, { text: `⏰ ${questions.length} question(s) still waiting for you:\n\n` +
        questions.map((q) => `#${q.id} · ${q.name || "+" + q.phone}: "${q.text.slice(0, 80)}"`).join("\n") +
        `\n\nReply  #id <answer>  or  #id skip` });
    }
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
setInterval(() => tick().catch((e) => console.error("tick", e.message)), 30 * 60e3);

start();
