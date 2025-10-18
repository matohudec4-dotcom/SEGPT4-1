export default async function handler(req, res) {
  // ---- helpers ----
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

  // ---- URL parametre (debug/timeout/passthrough a nudge prepínače) ----
  let debug = false;
  let passthrough = false;
  let timeoutOverride = null;
  let urlObj = null;
  let langOverride = null;
  let gameQuery = null;
  let userQuery = null;
  let autoMode = false;
  let chanceParam = null;

  try {
    urlObj = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const sp = urlObj.searchParams;
    debug = sp.get("debug") === "1";
    passthrough = sp.get("passthrough") === "1"; // debug + zavolaj OpenAI
    const t = sp.get("t");
    if (t && /^\d+$/.test(t)) timeoutOverride = Number(t);
    langOverride = sp.get("lang"); // sk|cz|en (voliteľné)
    gameQuery = sp.get("game");    // z Nightbota
    userQuery = sp.get("user");    // z Nightbota
    autoMode = sp.get("auto") === "1";
    chanceParam = sp.get("chance");
  } catch (_) {}

  // ---- vstup a dekódovanie ----
  let raw = getUserText(req);

  let decoded = raw || "";
  try { decoded = decodeURIComponent(decoded); } catch (_) {}
  try { decoded = decodeURIComponent(decoded); } catch (_) {}
  decoded = decoded.replace(/\+/g, " "); // SE/NB posielajú + za medzery

  const prompt = (decoded || "")
    .toString()
    .slice(0, 600)
    .replace(/@\w+/g, "")
    .replace(/\s+/g, " ")
    .trim();

  // DEBUG: ak nie je 'passthrough=1', vráť JSON okamžite (bez volania OpenAI)
  if (debug && !passthrough) {
    return res.status(200).json({
      ok: true,
      model: process.env.OPENAI_MODEL || "gpt-4o-mini",
      rawReceived: raw,
      decodedPrompt: prompt,
      promptLength: prompt.length,
      auto: autoMode,
      chance: chanceParam
    });
  }

  if (!process.env.OPENAI_API_KEY) {
    return res.status(500).send("❌ OPENAI_API_KEY chýba vo Vercel → Settings → Environment Variables.");
  }

  // ---- jazyk: auto-detekcia alebo override ----
  function detectLang(text) {
    const t = (text || "").toLowerCase();
    const skChars = /[áäčďéíĺľňóôŕšťúýž]/;
    const czChars = /[ěščřžýáíéúůóťďň]/;
    if (["sk","cz","en"].includes(t)) return t; // ak niekto pošle priamo kód
    if (skChars.test(t) || /(čo|prečo|ako|kde|kedy)/.test(t)) return "sk";
    if (czChars.test(t) || /(co|proč|jak|kde|kdy)/.test(t)) return "cz";
    if (/[a-z]/.test(t)) return "en";
    return "sk";
  }
  const ENV_LANG = process.env.BOT_LANG || "sk"; // "sk" | "cz" | "en" | "auto"
  const LANG = langOverride && ["sk","cz","en"].includes(langOverride.toLowerCase())
    ? langOverride.toLowerCase()
    : (ENV_LANG === "auto" ? detectLang(prompt) : ENV_LANG);

  // ---- konfigurácia (GPT-4) ----
  const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
  const MAX_CHARS = Number(process.env.MAX_CHARS || 300);
  const TONE = process.env.BOT_TONE || "priateľský, vtipný, stručný, jemne sarkastický";
  const STREAMER = process.env.STREAMER_NAME || "Sokrat";
  const GAME = gameQuery ? decodeURIComponent(String(gameQuery)) : (process.env.STREAM_GAME || "Twitch");
  const USER = userQuery ? decodeURIComponent(String(userQuery)) : (req.query?.user ? decodeURIComponent(String(req.query.user)) : "kamoš");
  const SAFE = (s) => s.replace(/https?:\/\/\S+/gi, "[link]").replace(/(.+)\1{2,}/g, "$1");

  // Detekcia témy (pre rýchle odpovede mimo AUTO)
  function detectTopic(t) {
    const s = (t || "").toLowerCase();
    if (/(ahoj|čau|cau|hello|hi|servus)/i.test(s)) return "greeting";
    if (/(počasie|pocasie|weather|forecast)/i.test(s)) return "weather";
    if (/(koľko|kolko|\d+\s*[\+\-\*\/]\s*\d+)/i.test(s)) return "math";
    if (/(cs2|counter[- ]?strike|valorant|league|dota|fortnite|minecraft|apex|lol\b)/i.test(s)) return "game";
    if (/(klíma|klima|klimat|ľadovc|ladovc|science|veda|prečo|preco)/i.test(s)) return "science";
    return "general";
  }
  const TOPIC = detectTopic(prompt);

  const isQuestion = /^[\s]*\?/.test(prompt) || /(prečo|ako|čo|what|why|how)/i.test(prompt);
  const baseTemp = Number(process.env.TEMPERATURE || 0.6);
  const temperature = (TOPIC === "science" || TOPIC === "game") ? 0.4 : (isQuestion ? 0.4 : baseTemp);

  // --- greeting handler (s prepínačom gptgreet) ---
const gptGreet = urlObj?.searchParams.get("gptgreet") === "1";
if (!autoMode && TOPIC === "greeting") {
  const now = Date.now();
  if (now - globalThis.__lastGreetAt < GREET_COOLDOWN_MS) {
    return res.status(204).send(); // ticho – nespamuj
  }
  globalThis.__lastGreetAt = now;

  // Ak chceš vynútiť GPT greeting:
  if (gptGreet) {
    // Malý, rýchly prompt priamo pre greeting
    const systemForGreet = [
      `Si Twitch chatbot na kanáli ${STREAMER}. Hra: ${GAME}. Jazyk: ${LANG}.`,
      `ÚLOHA: Napíš jednu krátku, vtipnú a mierne troll hlášku na privítanie používateľa ${USER}.`,
      `Buď láskavý a bezpečný, žiadne urážky ani NSFW. Max ${MAX_CHARS} znakov.`
    ].join(" ");

    const payload = {
      model: MODEL,
      messages: [
        { role: "system", content: systemForGreet },
        { role: "user", content: `Vytvor 1 vetu. Meno: ${USER}. Hra: ${GAME}.` }
      ],
      max_tokens: 60,
      temperature
    };

    // krátky timeout stačí (Nightbot zvládne ±3s, ale držme to svižné)
    const TIMEOUT_MS = Number(timeoutOverride ?? process.env.TIMEOUT_MS ?? 1500);
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);

    try {
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
      if (!resp.ok) {
        const code = data?.error?.code || resp.status;
        const msg  = data?.error?.message || "Neznáma chyba OpenAI.";
        return res.status(500).send(`🤖 Chyba pri generovaní (${code}): ${msg}`);
      }

      let text = data?.choices?.[0]?.message?.content?.trim() || "";
      if (!text) text = wittyGreeting(LANG, USER, GAME); // záloha
      return res.status(200).send(SAFE(text).slice(0, MAX_CHARS));
    } catch {
      // pri chybe zober statickú hlášku
      const msg = wittyGreeting(LANG, USER, GAME);
      return res.status(200).send(SAFE(msg).slice(0, MAX_CHARS));
    }
  }

  // Default: rýchly statický výber (bez GPT)
  const msg = wittyGreeting(LANG, USER, GAME);
  return res.status(200).send(SAFE(msg).slice(0, MAX_CHARS));
}

  // --- AUTO-NUDGE: náhodný skip a špeciálna persona ---
  const CHANCE = Number.isFinite(Number(chanceParam)) ? Math.min(1, Math.max(0, Number(chanceParam))) : 0.6;
  if (autoMode && Math.random() > CHANCE) {
    return res.status(204).send(); // ticho (žiadna správa)
  }
  let systemForUse = systemPrompt;
  if (autoMode) {
    systemForUse = [
      `Si Twitch chatbot na kanáli ${STREAMER}. Aktuálna hra: ${GAME}. Hovor jazykom: ${LANG}.`,
      `ÚLOHA: Zváž, či napísať JEDNU krátku a relevantnú vetu do chatu.`,
      `Ak nič zmysluplné nenapadne, odpovedz PRESNE: SKIP`,
      `Ak niečo povieš, buď priateľský, vtipný a jemne troll, max ${MAX_CHARS} znakov, žiadne @mentions.`,
      `Nepíš otázky nasilu. Buď prirodzený.`
    ].join(" ");
  }

  // --- greeting handler: vždy GPT generovanie ---
if (!autoMode && TOPIC === "greeting") {
  const now = Date.now();
  if (now - globalThis.__lastGreetAt < GREET_COOLDOWN_MS) {
    return res.status(204).send(); // ticho – nespamuj
  }
  globalThis.__lastGreetAt = now;

  const systemForGreet = [
    `Si Twitch chatbot na kanáli ${STREAMER}. Hra: ${GAME}. Jazyk: ${LANG}.`,
    `ÚLOHA: Napíš jednu krátku, vtipnú a mierne troll hlášku na privítanie používateľa ${USER}.`,
    `Buď priateľský, láskavý a bezpečný. Žiadne urážky ani NSFW. Max ${MAX_CHARS} znakov.`,
    `Používaj ${TONE}.`
  ].join(" ");

  const payload = {
    model: MODEL,
    messages: [
      { role: "system", content: systemForGreet },
      { role: "user", content: `Vytvor jednu krátku vetu na privítanie používateľa ${USER} v hre ${GAME}.` }
    ],
    max_tokens: 80,
    temperature: 0.8 // viac kreativity
  };

  const TIMEOUT_MS = Number(timeoutOverride ?? process.env.TIMEOUT_MS ?? 2000);
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);

  try {
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
    if (!resp.ok) {
      const code = data?.error?.code || resp.status;
      const msg = data?.error?.message || "Neznáma chyba OpenAI.";
      return res.status(500).send(`🤖 Chyba pri generovaní (${code}): ${msg}`);
    }

    let text = data?.choices?.[0]?.message?.content?.trim() || "";
    if (!text) text = "Ahoj, vitaj späť v chate! 😄";
    return res.status(200).send(SAFE(text).slice(0, MAX_CHARS));
  } catch {
    // fallback ak GPT nestihne odpovedať
    const msg = `Ahoj ${USER}, ${GAME} bez teba by nebol ono! 😏`;
    return res.status(200).send(SAFE(msg).slice(0, MAX_CHARS));
  }
}
  if (!autoMode && TOPIC === "math") {
    const m = prompt.match(/(\d+)\s*([+\-*\/])\s*(\d+)/);
    if (m) {
      const a = Number(m[1]), b = Number(m[3]), op = m[2];
      const ans = op === "+" ? a+b : op === "-" ? a-b : op === "*" ? a*b : b!==0 ? Math.round((a/b)*100)/100 : "∞";
      return res.status(200).send(`${a} ${op} ${b} = ${ans}`);
    }
  }
  if (!autoMode && TOPIC === "weather") {
    return res.status(200).send(LANG === "en"
      ? "I don’t have live forecast. Add city/date or use your weather bot. 🌤️"
      : (LANG === "cz"
        ? "Nemám živou předpověď. Přidej město/datum nebo použij weather bota. 🌤️"
        : "Nemám live predpoveď. Pridaj mesto/dátum alebo použi weather bota. 🌤️"));
  }

  try {
    // --- payload pre GPT-4 (klasické parametre) ---
    const userContent = autoMode
      ? `Vygeneruj nenútený, krátky a vtipný nudge podľa hry "${GAME}". Ak nič zmysluplné, odpovedz SKIP.`
      : (prompt || "Pozdrav chat a predstav sa jednou vetou.");

    const payload = {
      model: MODEL,
      messages: [
        { role: "system", content: systemForUse },
        { role: "user", content: userContent }
      ],
      max_tokens: autoMode ? 120 : 140, // auto-nudge kratšie a rýchle
      temperature
    };

    // --- timeout: 850ms default (SE/NB), override; pri debug+passthrough dlhší ---
    let TIMEOUT_MS = Number(timeoutOverride ?? process.env.TIMEOUT_MS ?? 850);
    if ((debug && passthrough && !timeoutOverride) || autoMode) {
      // auto-nudge/Nightbot môžu mať viac času
      TIMEOUT_MS = Math.max(TIMEOUT_MS, 2000);
    }

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

    // DEBUG INSPECT: surový OpenAI JSON (len ak debug=1&inspect=1)
    if (debug && urlObj && urlObj.searchParams.get("inspect") === "1") {
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

    if (!text && typeof first?.text === "string") text = first.text;
    if (!text && typeof data?.output_text === "string") text = data.output_text;
    if (!text || !text.trim()) text = "Skús otázku napísať konkrétnejšie (max 8 slov).";

    const msg = SAFE(text.trim()).slice(0, MAX_CHARS);

    // AUTO-NUDGE: ak GPT povie SKIP, nepošleme nič
    if (autoMode && /^skip$/i.test(msg)) {
      return res.status(204).send();
    }

    return res.status(200).send(msg);

  } catch (_) {
    // Timeout/sieť → krátky faktický fallback (iba pre normálne otázky)
    if (autoMode) return res.status(204).send(); // v auto móde radšej ticho
    const p = (prompt || "").toLowerCase();
    const quick =
      /ľadovc|ladovc/.test(p)
        ? (LANG === "en" ? "Glaciers melt mainly due to global warming and greenhouse gases."
           : LANG === "cz" ? "Ledovce tají hlavně kvůli globálnímu oteplování a skleníkovým plynům."
           : "Ľadovce sa topia hlavne kvôli globálnemu otepľovaniu a skleníkovým plynom.")
        : (LANG === "en" ? "Please write it shorter (up to 8 words)."
           : LANG === "cz" ? "Zkus to prosím napsat kratší (do 8 slov)."
           : "Skús to prosím napísať kratšie (do 8 slov).");
    return res.status(200).send(quick.slice(0, MAX_CHARS));
  }
}
