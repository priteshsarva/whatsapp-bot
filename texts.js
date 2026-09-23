// The few fixed lines the bot sends without asking the model: follow-up nudges,
// opt-out, "let me check", and errors. Everything else is written by the assistant
// in the client's own language. Edit the wording here.
const d = (x) => (x ? new Date(x).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }) : "-");
const rs = (n) => "₹" + Number(n || 0).toLocaleString("en-IN");

const T = {
  en: {
    checking: "Let me check this with the team and get back to you shortly.",
    media: "Got it, thanks — let me look at this and come back to you.",
    optedOut: "Okay, no more reminders from us. You can still message anytime.",
    error: "Sorry, something went wrong on our side. Please send that again in a minute.",
    followups: [
      "Hi, just checking in — any thoughts on this?",
      "No rush at all. Whenever you want to take this forward, I'm here.",
    ],
  },
  hinglish: {
    checking: "Main team se confirm karke abhi batata hoon.",
    media: "Mil gaya, thanks — dekh kar batata hoon.",
    optedOut: "Theek hai, ab reminder nahi bhejenge. Aap kabhi bhi message kar sakte hain.",
    error: "Sorry, hamari taraf se kuch gadbad ho gayi. Ek minute baad dobara bhejiye.",
    followups: [
      "Hi, bas puchhna tha — is baare mein kya socha aapne?",
      "Koi jaldi nahi hai ji. Jab bhi aage badhna ho, main yahin hoon.",
    ],
  },
  hi: {
    checking: "मैं टीम से पूछकर अभी बताता हूँ।",
    media: "मिल गया, धन्यवाद — देखकर बताता हूँ।",
    optedOut: "ठीक है, अब रिमाइंडर नहीं भेजेंगे। आप कभी भी मैसेज कर सकते हैं।",
    error: "क्षमा करें, हमारी तरफ़ से कुछ गड़बड़ हुई। एक मिनट बाद दोबारा भेजिए।",
    followups: [
      "नमस्ते, बस पूछना था — इस बारे में आपने क्या सोचा?",
      "कोई जल्दी नहीं है जी। जब भी आगे बढ़ना हो, मैं यहीं हूँ।",
    ],
  },
};

export const t = (lang) => T[lang] || T.hinglish;

// Owner-side summary for a question the assistant handed over.
export function ownerSummary({ id, name, phone, text, lang, contact, kind }) {
  const lines = [`❓ #${id} · ${name || "Unknown"} (+${phone || "?"})`];
  if (contact?.user) {
    lines.push(`👤 ${contact.user.email || "no email"}`);
    for (const s of contact.sites || []) lines.push(`🏪 ${s.slug || s.domain} · ${s.type} · ${s.status}${s.plan ? " · " + s.plan : ""} · exp ${d(s.expiry_date)}`);
    if (contact.invoices?.length) lines.push(`💳 ${contact.invoices.length} unpaid (${contact.invoices.map((i) => rs(i.amount)).join(", ")})`);
    if (contact.orders?.length) lines.push(`📦 last order ${contact.orders[0].order_no} · ${contact.orders[0].status}`);
  } else {
    lines.push("👤 Not a registered client");
  }
  lines.push(`🗣 ${lang}${kind ? " · " + kind : ""}`, "", `"${text}"`, "",
    `Reply: quote this message with your answer, or  #${id} <answer>  ·  #${id} =<answer no>  ·  #${id} skip`);
  return lines.join("\n");
}

export const OWNER_HELP =
  "Owner commands:\n• Quote a question message + type your answer (sent word for word)\n• #12 <answer> — answer and save it\n• #12 =5 — reply with saved answer 5\n• #12 skip — ignore\n• #12 fix <better wording> — rewrite a saved answer\n• reset 98xxxxxxxx — forget that chat's history, next message starts fresh\n• on 98xxxxxxxx — let the bot handle that chat (also old chats)\n• off 98xxxxxxxx — bot stays out of that chat\n\nSaved answers + business info: portal → Admin → WhatsApp bot.";
