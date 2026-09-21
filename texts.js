// Every fixed bot message, in en / hinglish / hi. Edit wording here.
const d = (x) => (x ? new Date(x).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }) : "-");
const rs = (n) => "₹" + Number(n || 0).toLocaleString("en-IN");

export const LANG_PROMPT =
  "Namaste 🙏 Please choose your language / Apni bhasha chunein:\n\n1️⃣ English\n2️⃣ Hinglish\n3️⃣ हिंदी";

const T = {
  en: {
    menuKnown: (name) =>
      `Hi ${name || "there"} 👋 What do you need?\n\n1️⃣ My plan & expiry\n2️⃣ Pay / renew\n3️⃣ My invoices\n4️⃣ My recent orders\n5️⃣ Talk to the owner\n6️⃣ Change language\n\nOr just type your question.`,
    menuUnknown:
      `Hi 👋 This number isn't linked to a verified account yet.\n\n1️⃣ How to join\n2️⃣ Talk to the owner\n3️⃣ Change language\n\nOr just type your question.\n(Already a member? Log in to the portal with mobile OTP once, then message again.)`,
    join: (url) => `Sign up here: ${url}\nAfter signing up, request your store and we'll approve it.`,
    noSites: "You don't have any store yet. Create one from the portal.",
    sites: (rows) => "Your stores:\n\n" + rows.map((s) => `• ${s.slug || s.domain} (${s.type}) — ${s.status}${s.plan ? ", " + s.plan : ""}, expires ${d(s.expiry_date)}`).join("\n"),
    noInvoices: "🎉 No pending invoices.",
    invoices: (rows) => "Pending invoices — reply with the number to get a payment link:\n\n" + rows.map((r, i) => `${i + 1}. ${r.invoice_no || ""} ${r.item} — ${rs(r.amount)}`).join("\n"),
    payLink: (url) => `Pay here: ${url}`,
    alreadyPaid: "This invoice is already paid ✅",
    invoicesLink: (url) => `All your invoices: ${url}/billing`,
    noOrders: "No orders yet.",
    orders: (rows) => "Recent orders:\n\n" + rows.map((o) => `• ${o.order_no} — ${o.status}, ${rs(o.total)}, ${o.buyer_name} (${d(o.created_at)})`).join("\n"),
    askOwner: "Sure — type your question and I'll pass it to the owner.",
    escalated: "I've sent your question to the owner. You'll get a reply here soon 🙏",
    tooMany: "Your earlier questions are with the owner already. Please wait for a reply 🙏",
    media: "Got it — I've forwarded this to the owner.",
    footer: "\n\n_Not what you needed? Reply *0* to ask the owner. Reply *menu* for options._",
    ownerReply: (a) => `Reply from the team:\n\n${a}`,
    error: "Something went wrong on our side. Please try again in a minute.",
    langSet: "Language set to English ✅",
    followups: [
      "Hi 👋 just checking in — did you get a chance to look at this? Reply *menu* for options or type your question.",
      "Hi again 🙂 Whenever you're ready, we're here to help you get your store running. Reply anytime.",
    ],
    optedOut: "Okay, no more reminders from us. You can still message anytime 🙏",
  },
  hinglish: {
    menuKnown: (name) =>
      `Hi ${name || "ji"} 👋 Kya chahiye?\n\n1️⃣ Mera plan aur expiry\n2️⃣ Payment / renew\n3️⃣ Mere invoices\n4️⃣ Recent orders\n5️⃣ Owner se baat karein\n6️⃣ Language badlein\n\nYa seedha apna sawal likhiye.`,
    menuUnknown:
      `Hi 👋 Yeh number abhi kisi verified account se linked nahi hai.\n\n1️⃣ Kaise judein\n2️⃣ Owner se baat karein\n3️⃣ Language badlein\n\nYa seedha apna sawal likhiye.\n(Pehle se member hain? Portal par ek baar mobile OTP se login karein, phir message karein.)`,
    join: (url) => `Yahan sign up karein: ${url}\nSign up ke baad store request karein, hum approve kar denge.`,
    noSites: "Aapka abhi koi store nahi hai. Portal se banaiye.",
    sites: (rows) => "Aapke stores:\n\n" + rows.map((s) => `• ${s.slug || s.domain} (${s.type}) — ${s.status}${s.plan ? ", " + s.plan : ""}, expiry ${d(s.expiry_date)}`).join("\n"),
    noInvoices: "🎉 Koi pending invoice nahi hai.",
    invoices: (rows) => "Pending invoices — payment link ke liye number bhejiye:\n\n" + rows.map((r, i) => `${i + 1}. ${r.invoice_no || ""} ${r.item} — ${rs(r.amount)}`).join("\n"),
    payLink: (url) => `Yahan payment karein: ${url}`,
    alreadyPaid: "Yeh invoice already paid hai ✅",
    invoicesLink: (url) => `Saare invoices: ${url}/billing`,
    noOrders: "Abhi tak koi order nahi.",
    orders: (rows) => "Recent orders:\n\n" + rows.map((o) => `• ${o.order_no} — ${o.status}, ${rs(o.total)}, ${o.buyer_name} (${d(o.created_at)})`).join("\n"),
    askOwner: "Theek hai — apna sawal likhiye, main owner tak pahuncha dunga.",
    escalated: "Aapka sawal owner ko bhej diya hai. Jaldi hi yahin reply aayega 🙏",
    tooMany: "Aapke pichhle sawal owner ke paas hain. Thoda wait kijiye 🙏",
    media: "Mil gaya — owner ko forward kar diya hai.",
    footer: "\n\n_Jawab sahi nahi laga? *0* bhejiye, owner se poochh lenge. Options ke liye *menu* likhiye._",
    ownerReply: (a) => `Team ka jawab:\n\n${a}`,
    error: "Hamari taraf se kuch gadbad hui. Ek minute baad try karein.",
    langSet: "Language Hinglish set ho gayi ✅",
    followups: [
      "Hi 👋 bas check kar rahe the — kya aapne dekha? Options ke liye *menu* likhiye ya apna sawal bhejiye.",
      "Hi 🙂 Jab bhi aap ready hon, store shuru karne mein hum help karenge. Kabhi bhi reply karein.",
    ],
    optedOut: "Theek hai, ab reminder nahi bhejenge. Aap kabhi bhi message kar sakte hain 🙏",
  },
  hi: {
    menuKnown: (name) =>
      `नमस्ते ${name || "जी"} 👋 आपको क्या चाहिए?\n\n1️⃣ मेरा प्लान और एक्सपायरी\n2️⃣ पेमेंट / रिन्यू\n3️⃣ मेरे इनवॉइस\n4️⃣ हाल के ऑर्डर\n5️⃣ ओनर से बात करें\n6️⃣ भाषा बदलें\n\nया सीधे अपना सवाल लिखिए।`,
    menuUnknown:
      `नमस्ते 👋 यह नंबर अभी किसी वेरिफ़ाइड अकाउंट से जुड़ा नहीं है।\n\n1️⃣ कैसे जुड़ें\n2️⃣ ओनर से बात करें\n3️⃣ भाषा बदलें\n\nया सीधे अपना सवाल लिखिए।\n(पहले से मेंबर हैं? पोर्टल पर एक बार मोबाइल OTP से लॉगिन करें, फिर मैसेज करें।)`,
    join: (url) => `यहाँ साइन अप करें: ${url}\nसाइन अप के बाद स्टोर रिक्वेस्ट करें, हम अप्रूव कर देंगे।`,
    noSites: "आपका अभी कोई स्टोर नहीं है। पोर्टल से बनाइए।",
    sites: (rows) => "आपके स्टोर:\n\n" + rows.map((s) => `• ${s.slug || s.domain} (${s.type}) — ${s.status}${s.plan ? ", " + s.plan : ""}, एक्सपायरी ${d(s.expiry_date)}`).join("\n"),
    noInvoices: "🎉 कोई पेंडिंग इनवॉइस नहीं है।",
    invoices: (rows) => "पेंडिंग इनवॉइस — पेमेंट लिंक के लिए नंबर भेजिए:\n\n" + rows.map((r, i) => `${i + 1}. ${r.invoice_no || ""} ${r.item} — ${rs(r.amount)}`).join("\n"),
    payLink: (url) => `यहाँ पेमेंट करें: ${url}`,
    alreadyPaid: "यह इनवॉइस पहले से पेड है ✅",
    invoicesLink: (url) => `सारे इनवॉइस: ${url}/billing`,
    noOrders: "अभी तक कोई ऑर्डर नहीं।",
    orders: (rows) => "हाल के ऑर्डर:\n\n" + rows.map((o) => `• ${o.order_no} — ${o.status}, ${rs(o.total)}, ${o.buyer_name} (${d(o.created_at)})`).join("\n"),
    askOwner: "ठीक है — अपना सवाल लिखिए, मैं ओनर तक पहुँचा दूँगा।",
    escalated: "आपका सवाल ओनर को भेज दिया है। जल्द ही यहीं जवाब आएगा 🙏",
    tooMany: "आपके पिछले सवाल ओनर के पास हैं। थोड़ा इंतज़ार कीजिए 🙏",
    media: "मिल गया — ओनर को फ़ॉरवर्ड कर दिया है।",
    footer: "\n\n_जवाब सही नहीं लगा? *0* भेजिए, ओनर से पूछ लेंगे। विकल्पों के लिए *menu* लिखिए।_",
    ownerReply: (a) => `टीम का जवाब:\n\n${a}`,
    error: "हमारी तरफ़ से कुछ गड़बड़ हुई। एक मिनट बाद कोशिश करें।",
    langSet: "भाषा हिंदी सेट हो गई ✅",
    followups: [
      "नमस्ते 👋 बस पूछना था — क्या आपने देखा? विकल्पों के लिए *menu* लिखिए या अपना सवाल भेजिए।",
      "नमस्ते 🙂 जब भी आप तैयार हों, स्टोर शुरू करने में हम मदद करेंगे। कभी भी जवाब दें।",
    ],
    optedOut: "ठीक है, अब रिमाइंडर नहीं भेजेंगे। आप कभी भी मैसेज कर सकते हैं 🙏",
  },
};

export const t = (lang) => T[lang] || T.hinglish;

// Owner-side summary for an escalated question.
export function ownerSummary({ id, name, phone, text, lang, contact, kind }) {
  const lines = [`❓ #${id} · ${name || "Unknown"} (+${phone || "?"})`];
  if (contact?.user) {
    lines.push(`👤 ${contact.user.email || "no email"}`);
    for (const s of contact.sites) lines.push(`🏪 ${s.slug || s.domain} · ${s.type} · ${s.status}${s.plan ? " · " + s.plan : ""} · exp ${d(s.expiry_date)}`);
    if (contact.invoices.length) lines.push(`💳 ${contact.invoices.length} unpaid (${contact.invoices.map((i) => rs(i.amount)).join(", ")})`);
    if (contact.orders.length) lines.push(`📦 last order ${contact.orders[0].order_no} · ${contact.orders[0].status}`);
  } else {
    lines.push("👤 Not a verified account");
  }
  lines.push(`🗣 ${lang}${kind ? " · " + kind : ""}`, "", `"${text}"`, "",
    `Reply: quote this message with your answer, or  #${id} <answer>  ·  #${id} =<faq no>  ·  #${id} skip`);
  return lines.join("\n");
}

export const OWNER_HELP =
  "Owner commands:\n• Quote a question message + type your answer\n• #12 <answer> — answer and save as FAQ\n• #12 =5 — reply with FAQ 5 (and learn this wording)\n• #12 skip — ignore\n• on 98xxxxxxxx — let the bot handle that chat (also old chats)\n• off 98xxxxxxxx — bot stays out of that chat\n\nEdit FAQs in the portal → Admin → WhatsApp.";
