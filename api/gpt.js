export default async function handler(req, res) {
  // -------- helpers --------
  function getUserText(req) {
    try {
      const q = req.query || {};
      const keys = ["prompt", "query", "text", "message", "msg", "q"];

      // a) pomenované parametre
      for (const k of keys) {
        const v = q[k];
        if (typeof v === "string" && v.trim()) return v;
      }

      // b) holý querystring (?tvoj%20text)
      const qKeys = Object.keys(q);
      if (qKeys.length === 1 && (q[qKeys[0]] === "" || typeof q[qKeys[0]] === "undefined")) {
        return qKeys[0];
      }

      // c) fallback – manuálne cez URL
      try {
        const u = new URL(req.url, `http://${req.headers.host || "localhost"}`);
        const sp = u.searchParams;
        for (const k of keys) {
          const v = sp.get(k);
          if (v && v.trim()) return v;
        }
        if ([...sp.keys()].length === 1) {
          const onlyKey = [...sp.keys()][0];
          const onlyVal = sp.get(onlyKey);
          if (!onlyVal || !onlyVal.trim()) return onlyKey;
        }
      } catch (_) {}
      return "";
    } catch (_) {
      return "";
    }
  }

  // Bezpečné čítanie URL parametrov (debug/timeout)
  let debug = false;
  let timeoutOverride = null;
  try {
    const u = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    debug = u.searchParams.get("debug") === "1";
    const t = u.searchParams.get("t");
    if (t && /^\d+$/.test(t)) timeoutOverride = Number(t);
  } catch (_) {}

  // -------- vstup a dekódovanie --------
  let raw = getUserText(req);

  let decoded = raw || "";
  try { decoded = decodeURIComponent(decoded); } catch (_) {}
  try { decoded = decodeURIComponent(decoded); } catch (_) {}
  decoded = decoded.replace(/\+/g, " "); // SE posiela + za medzery

  const prompt = (decoded || "")
    .toString()
    .slice(0, 600)
    .replace(/@\w+/g, "")
    .replace(/\s+/g, " ")
    .trim();

  // DEBUG: vráť čo endpoint číta (bez volania OpenAI)
  if (debug && !(new URL(req.url, `http://${req.headers.host||"localhost"}`)).searchParams.get("inspect")) {
    return res.status(200).json({
      ok: true,
      model: process.env.OPENAI_MODEL || "gpt-4o-mini",
      rawReceived: raw,
      decodedPrompt: prompt,
      promptLength: prompt.length
    });
  }

  if (!process.env.OPENAI_API_KEY) {
    return res.status(500).send("❌ OPENAI_API_KEY chýba vo Vercel → Settings → Environment Variables.");
  }

  // -------- konfigurácia (GPT-4) --------
  const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini"; // pevne GPT-4 rodina
  const LANG = process.env.BOT_LANG || "sk";
  const MAX_CHARS = Number(process.env.MAX_CHARS || 120); // kratšie = rýchlejšie do SE
  const TONE = process.env.BOT_TONE || "priateľský, stručný, vecný";
  const STREAMER = process.env.STREAMER_NAME || "streamer";
  const GAME = process.env.STREAM_GAME || "Twitch";
  const SAFE = (s) => s.replace(/https?:\/\/\S+/gi, "[link]").replace(/(.+)\1{2,}/g, "$1");

  const isQuestion = /^[\s]*\?/.test(prompt) || /(prečo|ako|čo|what|why|how)/i.test(prompt);
  const temperature = isQuestion ? 0.4 : Number(process.env.TEMPERATURE || 0.6);

  const systemPrompt = [
    `Si Twitch chatbot na kanáli ${STREAMER}, odpovedaj vecne a v slovenčine.`,
    `Používaj ${TONE}. Max ${MAX_CHARS} znakov.`,
    "Odpovedaj jasne a priamo (1–2 vety).",
    "Ak otázka nedáva zmysel, odpovedz neutrálne a krátko.",
    "Pri vede/hrach buď faktický a stručný.",
    "Nezačínaj ospravedlnením, vyhni sa 'neviem čo myslíš'.",
    `Kontext: hráme ${GAME}, komunita je priateľská.`
  ].join(" ");

  try {
    // --- payload pre GPT-4 (klasické parametre) ---
    const payload = {
      model: MODEL,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: prompt || "Pozdrav chat a predstav sa jednou vetou." }
      ],
      max_tokens: 40,         // krátke odpovede pre SE
      temperature             // GPT-4 podporuje temperature
    };

    // --- timeout: 850ms default (SE), override cez &t=... ---
    const TIMEOUT_MS = Number(timeoutOverride ?? process.env.TIMEOUT_MS ?? 850);
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);

    const resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload),
      signal: ctrl.signal
    }).finally(() => clearTimeout(t));

    const data = await resp.json().catch(() => ({}));

    // INSPECT: surový OpenAI JSON (len pri debug=1&inspect=1)
    if (debug && (new URL(req.url, `http://${req.headers.host||"localhost"}`)).searchParams.get("inspect") === "1") {
      return res.status(resp.status).json(data);
    }

    if (!resp.ok) {
      const code = data?.error?.code || resp.status;
      const msg  = data?.error?.message || "Neznáma chyba OpenAI.";
      return res.status(500).send(`🤖 Chyba pri generovaní (${code}): ${msg}`);
    }

    // robustný extraktor textu
    const first = Array.isArray(data?.choices) ? data.choices[0] : null;
    let text =
      first?.message?.content && typeof first.message.content === "string"
        ? first.message.content
        : "";

    if (!text && Array.isArray(first?.message?.content)) {
      text = first.message.content
        .map(part => (typeof part?.text === "string" ? part.text : (typeof part === "string" ? part : "")))
        .filter(Boolean)
        .join(" ")
        .trim();
    }

    if (!text && typeof first?.text === "string") {
      text = first.text;
    }
    if (!text && typeof data?.output_text === "string") {
      text = data.output_text;
    }
    if (!text || !text.trim()) {
      text = "Skús otázku napísať konkrétnejšie (max 8 slov).";
    }

    text = SAFE(text.trim()).slice(0, MAX_CHARS);
    return res.status(200).send(text);

  } catch (_) {
    // Timeout/sieť → krátky faktický fallback
    const p = (prompt || "").toLowerCase();
    const quick =
      /ľadovc|ladovc/.test(p)
        ? "Ľadovce sa topia hlavne kvôli globálnemu otepľovaniu a skleníkovým plynom."
        : "Skús to prosím napísať kratšie (do 8 slov).";
    return res.status(200).send(quick.slice(0, MAX_CHARS));
  }
}
