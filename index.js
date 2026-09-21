// WhatsApp support bot (no AI). Linked-device connection via Baileys; all data
// and FAQ matching come from the backend's /internal/wa routes.
//   Store owner -> menu / own account data / FAQ match -> else escalate to OWNER_PHONE.
//   Owner quote-replies (or "#12 answer") -> answer goes back + becomes a FAQ.
import makeWASocket, { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, normalizeMessageContent, generateMessageIDV2 } from "baileys";
import pino from "pino";
import QRCode from "qrcode";
import fs from "fs";
import { t, LANG_PROMPT, ownerSummary, OWNER_HELP } from "./texts.js";

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
const GREETINGS = new Set(["menu", "hi", "hii", "hello", "hey", "namaste", "नमस्ते", "start", "help"]);
const HINDI = /[ऀ-ॿ]/;

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

// ponytail: menu position lives in memory — a restart just drops people back to the main menu.
const sessions = new Map();
const session = (k) => { if (!sessions.has(k)) sessions.set(k, { menu: "main", escalations: [] }); return sessions.get(k); };

// Chats where you typed yourself mid-conversation: jid -> pause-until ms.
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

// "typing…" + a short human-ish pause: replies that land instantly get numbers flagged.
async function say(jid, text) {
  await sock.sendPresenceUpdate("composing", jid).catch(() => {});
  await sleep(800 + Math.random() * 1500);
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

// Owner reply body: "skip" | "=5" | answer text
const parseReply = (s) => /^skip$/i.test(s) ? { skip: true } : /^=\s*\d+$/.test(s) ? { faq_id: +s.match(/\d+/)[0] } : { text: s };

async function handleOwner(jid, text, quoted) {
  const onOff = text.match(/^(on|off)\s+([\d\s+]{10,})$/i);
  if (onOff) {
    const status = onOff[1].toLowerCase() === "on" ? "active" : "off";
    const r = await api("POST", "/chats/set", { phone: onOff[2], status }).catch((e) => ({ error: e.message }));
    return send(jid, { text: r.error ? `⚠️ ${r.error}` : r.updated ? `✅ Bot ${onOff[1].toLowerCase()} for ${onOff[2].trim()}` : `No chat found for ${onOff[2].trim()}` });
  }
  const tag = text.match(/^#(\d+)\s*([\s\S]*)$/);
  let body;
  if (tag) body = { id: +tag[1], ...parseReply(tag[2].trim()) };
  else if (quoted && text) body = { owner_msg_id: quoted, ...parseReply(text) };
  else return send(jid, { text: OWNER_HELP });
  try {
    const r = await api("POST", "/answer", body);
    const q = r.question;
    if (r.answer) await say(q.jid, t(q.lang).ownerReply(r.answer));
    await send(jid, { text: r.answer ? `✅ #${q.id} sent to ${q.name || "+" + q.phone} · saved as FAQ ${r.faq_id}` : `⏭ #${q.id} skipped` });
  } catch (e) {
    await send(jid, { text: `⚠️ ${e.message}` });
  }
}

// You typed in a chat from the bot phone. Before the client has ever replied, that's
// your starter message: the chat becomes the bot's to carry on. Once the client is
// talking, it means you've stepped in, so the bot keeps quiet for PAUSE_MIN.
async function handleManualOut(jid) {
  const r = await api("POST", "/chats/event", { jid, dir: "out" });
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
  if (m.key.fromMe) {
    if (botSent.has(m.key.id) || jid === OWNER_JID || phone === OWNER) return;
    return handleManualOut(jid);
  }
  if (c.stickerMessage) return;

  const text = (c.conversation || c.extendedTextMessage?.text || c.imageMessage?.caption ||
    c.videoMessage?.caption || c.documentMessage?.caption || "").trim();
  if (phone && phone === OWNER) return handleOwner(jid, text, c.extendedTextMessage?.contextInfo?.stanzaId);

  const kind = c.audioMessage ? "voice note" : c.imageMessage ? "image" : c.videoMessage ? "video" : c.documentMessage ? "document" : null;
  if (!text && !kind) return;

  // Is this chat the bot's? Legacy (pre-GO_LIVE) and muted chats are left to you.
  const { chat } = await api("POST", "/chats/event", { jid, phone, dir: "in" });
  if (chat.status !== "active") return;
  if ((pausedUntil.get(jid) || 0) > Date.now()) return;

  const name = m.pushName || "";
  const s = session(phone || jid);
  if (OPT_OUT.test(text)) {
    await api("POST", "/chats/set", { jid: chat.jid, opted_out: true });
    return say(jid, t(s.lang).optedOut);
  }
  let contact;
  try { contact = await api("GET", `/contact/${phone || "0"}`); }
  catch (e) { console.error("contact", e.message); return say(jid, t(s.lang).error); }

  let lang = contact.lang || s.lang;
  const L = () => t(lang);
  const setLang = async (l) => { lang = s.lang = l; if (phone) await api("PUT", `/contact/${phone}/lang`, { lang: l }); };
  const menu = () => (contact.user ? L().menuKnown(contact.user.name) : L().menuUnknown);

  async function escalate(q, withMedia = false) {
    const now = Date.now();
    s.escalations = s.escalations.filter((x) => now - x < 30 * 60e3);
    if (s.escalations.length >= 3) return say(jid, L().tooMany); // stops one chat flooding the owner
    s.escalations.push(now);
    const { id } = await api("POST", "/questions", { phone, jid, name, text: q, lang });
    const sent = await send(OWNER_JID, { text: ownerSummary({ id, name, phone, text: q, lang, contact, kind: withMedia ? kind : null }) });
    if (withMedia) await send(OWNER_JID, { forward: m }).catch(() => {});
    await api("PATCH", `/questions/${id}`, { owner_msg_id: sent.key.id });
    s.lastQ = null;
    return say(jid, withMedia ? L().media : L().escalated);
  }

  async function answerFreeText(q) {
    const r = await api("POST", "/match", { text: q, lang });
    s.lastQ = q;
    return r.answer ? say(jid, r.answer + L().footer) : escalate(q);
  }

  // --- language: picked once, remembered
  if (s.menu === "lang") {
    const pick = { 1: "en", 2: "hinglish", 3: "hi" }[text];
    if (!pick) return say(jid, LANG_PROMPT);
    await setLang(pick);
    s.menu = "main";
    await say(jid, L().langSet);
    const pending = s.pendingText; s.pendingText = null;
    return pending ? answerFreeText(pending) : say(jid, menu());
  }
  if (!lang) {
    if (HINDI.test(text)) await setLang("hi");
    else {
      s.menu = "lang";
      if (text && !GREETINGS.has(text.toLowerCase())) s.pendingText = text;
      return say(jid, LANG_PROMPT);
    }
  }

  if (kind) return escalate(text || `[${kind}]`, true);

  const lower = text.toLowerCase();
  if (GREETINGS.has(lower)) { s.menu = "main"; return say(jid, menu()); }
  if (text === "0") {
    if (s.lastQ) return escalate(s.lastQ);
    s.menu = "ask"; return say(jid, L().askOwner);
  }
  if (s.menu === "ask") { s.menu = "main"; return escalate(text); }

  if (s.menu === "invoices" && /^\d+$/.test(text) && s.invoices?.[+text - 1]) {
    s.menu = "main";
    const r = await api("POST", `/invoices/${s.invoices[+text - 1].id}/pay-link`, { phone });
    return say(jid, r.paid ? L().alreadyPaid : L().payLink(r.url));
  }

  if (/^\d$/.test(text)) {
    s.menu = "main";
    const known = {
      1: () => say(jid, contact.sites.length ? L().sites(contact.sites) : L().noSites),
      2: () => {
        if (!contact.invoices.length) return say(jid, L().noInvoices);
        s.invoices = contact.invoices; s.menu = "invoices";
        return say(jid, L().invoices(contact.invoices));
      },
      3: () => say(jid, L().invoicesLink(contact.app_url)),
      4: () => say(jid, contact.orders.length ? L().orders(contact.orders) : L().noOrders),
      5: () => { s.menu = "ask"; return say(jid, L().askOwner); },
      6: () => { s.menu = "lang"; return say(jid, LANG_PROMPT); },
    };
    const unknown = {
      1: () => say(jid, L().join(contact.app_url)),
      2: () => { s.menu = "ask"; return say(jid, L().askOwner); },
      3: () => { s.menu = "lang"; return say(jid, LANG_PROMPT); },
    };
    const act = (contact.user ? known : unknown)[text];
    return act ? act() : say(jid, menu());
  }

  return answerFreeText(text);
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
    await send(c.jid, { text: msgs[Math.min(c.followups, msgs.length - 1)] });
    await api("POST", "/chats/followed-up", { jid: c.jid });
    await sleep(20e3 + Math.random() * 40e3); // spread out — a burst of identical texts looks like spam
  }
}
setInterval(() => tick().catch((e) => console.error("tick", e.message)), 30 * 60e3);

start();
