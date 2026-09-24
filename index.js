// WhatsApp assistant (Baileys linked device). No menus, no greeting script, no
// language question: every client message goes to the backend's /internal/wa/reply,
// which holds the conversation. Anything it can't handle is sent to OWNER_PHONE,
// and the owner's answer goes back to the client and is saved for next time.
import makeWASocket, { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, normalizeMessageContent, generateMessageIDV2 } from "baileys";
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

// 90s: a /reply can legitimately take a while (model + its retry + the AI queue).
async function api(method, path, body) {
  const r = await fetch(`${BACKEND_URL.replace(/\/+$/, "")}/internal/wa${path}`, {
    method,
    headers: { "content-type": "application/json", "x-internal-key": WA_INTERNAL_KEY },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(90000),
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
const istMidnightMs = () => new Date(`${istDate()}T00:00:00+05:30`).getTime();   // start of today, IST

// Phone digits of the sender. Newer WhatsApp chats can arrive as a privacy "@lid" id.
async function phoneOf(key) {
  const pn = (j) => j.split("@")[0].split(":")[0];
  for (const j of [key.remoteJidAlt, key.senderPn, key.remoteJid]) if (j?.endsWith("@s.whatsapp.net")) return pn(j);
  const mapped = await sock.signalRepository?.lidMapping?.getPNForLID?.(key.remoteJid)?.catch?.(() => null);
  return mapped ? pn(mapped) : "";
}

// Owner reply body:
//   "ok" / "haan" / "send"        -> send the draft as it is
//   "as is <text>"                -> send exactly these words, no drafting
//   "skip" | "=5" | "fix <text>"  -> as before
//   anything else                 -> your note (answer OR instruction) -> drafted for your OK
const parseReply = (s) =>
  /^(ok|okay|ok ji|haan|haan ji|yes|y|send|bhej do|theek hai|sahi hai|👍)$/i.test(s.trim()) ? { confirm: true }
  : /^skip$/i.test(s) ? { skip: true }
  : /^=\s*\d+$/.test(s) ? { faq_id: +s.match(/\d+/)[0] }
  : /^fix\s+/i.test(s) ? { text: s.replace(/^fix\s+/i, ""), fix: true }
  : /^as is\s+/i.test(s) ? { text: s.replace(/^as is\s+/i, ""), raw: true }
  : { text: s };

async function handleOwner(jid, text, quoted) {
  const onOff = text.match(/^(on|off)\s+([\d\s+]{10,})$/i);
  if (onOff) {
    const status = onOff[1].toLowerCase() === "on" ? "active" : "off";
    const r = await api("POST", "/chats/set", { phone: onOff[2], status }).catch((e) => ({ error: e.message }));
    return send(jid, { text: r.error ? `⚠️ ${r.error}` : r.updated ? `✅ Bot ${onOff[1].toLowerCase()} for ${onOff[2].trim()}` : `No chat found for ${onOff[2].trim()}` });
  }
  if (/^(ping|status)$/i.test(text.trim())) {
    const up = Math.round(process.uptime() / 60);
    const ok = await api("GET", "/questions/stale?hours=999999").then(() => "reachable").catch((e) => `UNREACHABLE (${e.message})`);
    return send(jid, { text: `✅ Bot alive · connected · up ${up} min\nBackend: ${ok}` });
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
  else if (text && parseReply(text).confirm) body = { confirm: true };  // plain "ok" -> the latest draft
  else return send(jid, { text: OWNER_HELP });
  try {
    const r = await api("POST", "/answer", body);
    const q = r.question;

    // Draft: show it to the owner and wait for their go-ahead.
    if (r.drafted) {
      const preview = await send(jid, {
        text: `📝 Draft for #${q.id} → ${q.name || "+" + q.phone}\n\n${r.draft}\n\n` +
              `Reply *ok* to send · type a correction to redo it · *#${q.id} as is <text>* to send your exact words`,
      });
      if (preview?.key?.id) await api("PATCH", `/questions/${q.id}`, { draft_msg_id: preview.key.id }).catch(() => {});
      return;
    }

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
  // Don't re-answer something we already replied to. WhatsApp re-delivers on reconnect,
  // so ids are remembered; the timestamp check only drops CLEARLY stale backlog (5+ min
  // older than our last reply) — a tight comparison silences the chat whenever the
  // sender's phone clock runs behind the server's.
  if (handled.has(m.key.id)) return;
  handled.add(m.key.id);
  if (handled.size > 3000) handled.delete(handled.values().next().value);
  if (chat.last_out_at && at < new Date(chat.last_out_at).getTime() - 5 * 60e3) return;
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
const WAIT_MS = Number(process.env.REPLY_WAIT_MS || 3500);          // quiet time before replying
const TYPING_STOP_MS = Number(process.env.REPLY_TYPING_STOP_MS || 1200); // they stopped typing -> go
const MAX_WAIT_MS = Number(process.env.REPLY_MAX_WAIT_MS || 60000); // ...but never hold longer than this
const pending = new Map();   // jid -> { first, timer, parts[], ctx }

function queue(ctx) {
  let p = pending.get(ctx.jid);
  if (!p) { p = { first: Date.now(), parts: [], ctx }; pending.set(ctx.jid, p); }
  p.ctx = { ...ctx, msg: ctx.kind ? ctx.msg : p.ctx.msg, kind: ctx.kind || p.ctx.kind };
  if (ctx.text) p.parts.push(ctx.text);
  hold(ctx.jid);
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
  if (!p) return;
  pending.delete(jid);
  const { phone, name, lang, kind, msg } = p.ctx;
  const text = p.parts.join("\n").trim();          // everything they said, as one message
  const s = session(phone || jid);

  const escalate = async (question, holding, withMedia = false) => {
    const now = Date.now();
    s.escalations = s.escalations.filter((x) => now - x < 30 * 60e3);
    // Too many already waiting on the owner: stop pinging them, but NEVER leave the
    // client on read — during a long AI outage that turns into total silence.
    if (s.escalations.length >= 6) {
      if (holding && now - (s.lastHold || 0) > 10 * 60e3) {
        s.lastHold = now;
        await say(jid, holding);
        await api("POST", "/sent", { jid, text: holding }).catch(() => {});
      }
      return;
    }
    s.escalations.push(now);
    const { id, duplicate } = await api("POST", "/questions", { phone, jid, name, text: question, lang });
    // Same question is already waiting on the owner — don't ping them a second time.
    // Just hold the client; the owner answers the one pending copy and it goes out.
    if (duplicate) { if (holding) { await say(jid, holding); await api("POST", "/sent", { jid, text: holding }).catch(() => {}); } return; }
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
    markInterest(jid, r.score);
    if (r.reply && !r.escalate) {
      await say(jid, r.reply);
      // Product photos from our catalogue — captions carry details, never prices.
      for (const p of r.products || []) {
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
// Labels only exist on WhatsApp BUSINESS accounts; on a normal account the first call
// fails and labelling switches itself off — the portal's Leads tab still has them all.
const LABELS = {
  hot:  { id: "kartify_hot",  name: "🔥 Hot lead",   color: 1 },
  warm: { id: "kartify_warm", name: "🙂 Interested", color: 4 },
};
let labelsOn = null;           // null = not tried yet, true/false after the first attempt
const labelled = new Map();    // jid -> score already applied
async function ensureLabels() {
  if (labelsOn !== null) return labelsOn;
  try {
    for (const l of Object.values(LABELS)) await sock.addLabel(OWNER_JID, { id: l.id, name: l.name, color: l.color });
    labelsOn = true;
  } catch (e) {
    labelsOn = false;
    console.log("labels off (needs WhatsApp Business on the bot number):", e.message);
  }
  return labelsOn;
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
let lastReminder = "", lastReport = "", lastSlowTick = 0;

async function reengageTick() {
  const h = istHour();
  if (h < 8 || h >= 23) return;
  const { chats } = await api("GET", `/chats/reengage?mins=${REENGAGE_MIN}`);
  for (const c of chats) {
    await say(c.jid, c.text);   // say() records the outgoing message, so this chat won't be picked again
    await sleep(3000 + Math.random() * 4000);
  }
}

async function reportTick() {
  if (istHour() < REPORT_HOUR || lastReport === istDate()) return;
  lastReport = istDate();
  const r = await api("GET", "/report/today");
  const n = (x) => x ?? 0;
  const byScore = Object.fromEntries((r.leads || []).map((l) => [l.score, l.n]));
  const lines = [
    `📊 *Today's WhatsApp report* — ${istDate()}`,
    "",
    `💬 ${n(r.msgs?.chats)} chats · ${n(r.msgs?.incoming)} messages in · ${n(r.msgs?.sent)} replies out`,
    `🆕 ${n(r.chats?.new_chats)} new chats (${n(r.chats?.you_started)} started by you)`,
    `🤖 ${n(r.qs?.answered_by_ai)} answered by the assistant · 👤 ${n(r.qs?.answered_by_you)} by you · ⏳ ${n(r.qs?.waiting_on_you)} waiting on you`,
    `🎯 Leads: 🔥 ${n(byScore.hot)} hot · 🙂 ${n(byScore.warm)} warm · ${n(byScore.cold)} cold`,
  ];
  if (r.hot?.length) {
    lines.push("", "*Interested today:*");
    for (const l of r.hot) {
      const facts = [l.business, l.city, l.sells].filter(Boolean).join(" · ");
      lines.push(`${l.score === "hot" ? "🔥" : "🙂"} ${l.name || "+" + l.phone}${facts ? " — " + facts : ""}\n   wa.me/${l.phone} · ${l.score_reason || ""}`);
    }
  }
  if (r.pending?.length) {
    lines.push("", "*Still waiting on you:*");
    for (const q of r.pending) lines.push(`#${q.id} · ${q.name || "+" + q.phone}: "${String(q.text).slice(0, 70)}"`);
    lines.push("Reply  #id <answer>  or  #id skip");
  }
  await send(OWNER_JID, { text: lines.join("\n") });
}

async function tick() {
  if (!sock?.user) return;
  await reengageTick().catch((e) => console.error("reengage", e.message));
  await reportTick().catch((e) => console.error("report", e.message));
  if (Date.now() - lastSlowTick < 30 * 60e3) return;
  lastSlowTick = Date.now();
  await slowTick();
}

async function slowTick() {
  const h = istHour();
  if (h < ACTIVE_HOURS[0] || h >= ACTIVE_HOURS[1]) return;

  if (lastReminder !== istDate()) {
    lastReminder = istDate();
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
