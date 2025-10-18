export default async function handler(req, res) {
  // ---- helper na extrakciu textu ----
  function getUserText(req) {
    try {
      const q = req.query || {};
      const keys = ["prompt", "query", "text", "message", "msg", "q"];
      for (const k of keys) {
        const v = q[k];
        if (typeof v === "string" && v.trim()) return v;
      }
      const qKeys = Object.keys(q);
      if (qKeys.length === 1 && (q[qKeys[0]] === "" || typeof q[qKeys[0]] === "undefined")) return qKeys[0];
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
      return "";
    } catch {
      return "";
    }
  }

  // ---- URL parametre ----
  let debug = false, passthrough = false, timeoutOverride = null, urlObj = null;
  let langOverride = null, gameQuery = null, userQuery = null, autoMode = false, chanceParam = null;

  try {
    urlObj = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const sp = urlObj.searchParams;
    debug = sp.get("debug") === "1";
    passthrough = sp.get("passthrough") === "1";
    const t = sp.get("t");
    if (t && /^\d+$/.test(t)) timeoutOverride = Number(t);
    langOverride = sp.get("lang");
    gameQuery = sp.get("game");
    userQuery = sp.get("user");
    autoMode = sp.get("auto") === "1";
    chanceParam = sp.get("chance");
  } catch {}

  // ---- dekódovanie vstupu ----
  let raw = getUserText(req);
  let decoded = raw || "";
  try { decoded = decodeURIComponent(decoded); } catch {}
  try { decoded = decodeURIComponent(decoded); } catch {}
  decoded = decoded.replace(/\+/g, " ");
  const prompt = decoded.toString().slice(0, 600).replace(/@\w+/g, "").replace(/\s+/g, " ").trim();

  // ---- DEBUG mód bez API volania ----
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

  // ---- kontrola API kľúča ----
  if (!process.env.OPENAI_API_KEY) {
    return res.status(500).send("❌ OPENAI_API_KEY chýba vo Vercel → Settings → Environment Variables.");
  }

  // ---- autodetekcia jazyka ----
  function detectLang(text) {
    const t = (text || "").toLowerCase();
    const skChars = /[áäčďéíĺľňóôŕšťúýž]/;
    const czChars = /[ěščřžýáíéúůóťďň]/;
    if (["sk", "cz", "en"].includes(t)) return t;
    if (skChars.test(t) || /(čo|prečo|ako|kde|kedy)/.test(t)) return "sk";
    if (czChars.test(t) || /(co|proč|jak|kde|kdy)/.test(t)) return "cz";
    if (/[a-z]/.test(t)) return "en";
    return "sk";
  }

  // ---- základná konfigurácia ----
  const ENV_LANG = process.env.BOT_LANG || "sk";
  const LANG = langOverride && ["sk", "cz", "en"].includes(langOverride.toLowerCase())
    ? langOverride.toLowerCase()
    : (ENV_LANG === "auto" ? detectLang(prompt) : ENV_LANG);

  const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
  const MAX_CHARS = Number(process.env.MAX_CHARS || 300);
  const TONE = process.env.BOT_TONE || "priateľský, vtipný, stručný, jemne troll";
  const STREAMER = process.env.STREAMER_NAME || "Sokrat";
  const GAME = gameQuery ? decodeURIComponent(String(gameQuery)) : (process.env.STREAM_GAME || "Twitch");
  const USER = userQuery ? decodeURIComponent(String(userQuery)) : (req.query?.user ? decodeURIComponent(String(req.query.user)) : "kamoš");
  const GREET_COOLDOWN_MS = Number(process.env.GREET_COOLDOWN_MS || 45000);
  const SAFE = (s) => s.replace(/https?:\/\/\S+/gi, "[link]").replace(/(.+)\1{2,}/g, "$1");

  // ---- helper: detekcia témy ----
  function detectTopic(t) {
    const s = (t || "").toLowerCase();
    if (/(ahoj|čau|cau|hello|hi|servus)/i.test(s)) return "greeting";
    if (/(počasie|pocasie|weather|forecast)/i.test(s)) return "weather";
    if (/(koľko|kolko|\d+\s*[\+\-*\/]\s*\d+)/i.test(s)) return "math";
    if (/(cs2|counter[- ]?strike|valorant|league|dota|fortnite|minecraft|apex|lol\b)/i.test(s)) return "game";
    if (/(klíma|klima|klimat|ľadovc|ladovc|science|veda|prečo|preco)/i.test(s)) return "science";
    return "general";
  }

  const TOPIC = detectTopic(prompt);
  const isQuestion = /^[\s]*\?/.test(prompt) || /(prečo|ako|čo|what|why|how)/i.test(prompt);
  const baseTemp = Number(process.env.TEMPERATURE || 0.6);
  const temperature = (TOPIC === "science" || TOPIC === "game") ? 0.4 : (isQuestion ? 0.4 : baseTemp);

  // ---- statická fallback greeting funkcia ----
  function wittyGreeting(lang, user, game) {
    const templates = [
      `Ahoj ${user}, zas späť — a aim si doniesol? 😏`,
      `Nazdar ${user}! ${game} bez teba je jak lobby bez toxíka 😂`,
      `Čauko ${user}, ideš rageovať alebo chillovať dnes? 😎`,
      `${user}, vitaj. Zas nás ideš učiť, ako sa ${game} *nehrá*? 🤣`,
      `Servus ${user}! Prišiel si po carry, však? 😉`,
      `Čau ${user}! Konečne niekto normálny v chate 😎`
    ];
    return templates[Math.floor(Math.random() * templates.length)];
  }

  // ---- greeting handler (GPT + fallback) ----
  if (!autoMode && TOPIC === "greeting") {
    try {
      const now = Date.now();
      if (now - (globalThis.__lastGreetAt || 0) < GREET_COOLDOWN_MS) {
        return res.status(204).send(); // ticho – cooldown
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
        max_tokens: 60,
        temperature: 0.8
      };

      const TIMEOUT_MS = Number(timeoutOverride ?? process.env.TIMEOUT_MS ?? 2500);
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

      if (!resp.ok) {
        const code = data?.error?.code || resp.status;
        const msg  = data?.error?.message || "Neznáma chyba OpenAI.";
        const fallback = wittyGreeting(LANG, USER, GAME);
        return res.status(200).send(SAFE(fallback).slice(0, MAX_CHARS));
      }

      let text = data?.choices?.[0]?.message?.content?.trim() || wittyGreeting(LANG, USER, GAME);
      return res.status(200).send(SAFE(text).slice(0, MAX_CHARS));
    } catch {
      const msg = wittyGreeting(LANG, USER, GAME);
      return res.status(200).send(SAFE(msg).slice(0, MAX_CHARS));
    }
  }

  // ---- jednoduché rýchle odpovede ----
  if (!autoMode && TOPIC === "math") {
    const m = prompt.match(/(\d+)\s*([+\-*\/])\s*(\d+)/);
    if (m) {
      const a = Number(m[1]), b = Number(m[3]), op = m[2];
      const ans = op === "+" ? a + b : op === "-" ? a - b : op === "*" ? a * b : b !== 0 ? Math.round((a / b) * 100) / 100 : "∞";
      return res.status(200).send(`${a} ${op} ${b} = ${ans}`);
    }
  }
  if (!autoMode && TOPIC === "weather") {
    return res.status(200).send(LANG === "en"
      ? "I don’t have live forecast. Add city/date or use your weather bot. 🌤️"
      : LANG === "cz"
        ? "Nemám živou předpověď. Přidej město/datum nebo použij weather bota. 🌤️"
        : "Nemám live predpoveď. Pridaj mesto/dátum alebo použi weather bota. 🌤️");
  }

  // ---- GPT hlavná odpoveď ----
  try {
    const systemPrompt = [
      `Si Twitch chatbot na kanáli ${STREAMER}. Aktuálna hra: ${GAME}. Hovor jazykom: ${LANG}.`,
      `Používaj ${TONE}. Max ${MAX_CHARS} znakov.`,
      "Buď stručný a priateľský."
    ].join(" ");

    const userContent = autoMode
      ? `Vygeneruj nenútený, krátky a vtipný nudge podľa hry "${GAME}". Ak nič zmysluplné, odpovedz SKIP.`
      : (prompt || "Pozdrav chat a predstav sa jednou vetou.");

    const payload = {
      model: MODEL,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userContent }
      ],
      max_tokens: 140,
      temperature
    };

    let TIMEOUT_MS = Number(timeoutOverride ?? process.env.TIMEOUT_MS ?? 1200);
    if (autoMode) TIMEOUT_MS = 2000;
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
    if (!resp.ok) {
      const code = data?.error?.code || resp.status;
      const msg  = data?.error?.message || "Neznáma chyba OpenAI.";
      return res.status(500).send(`🤖 Chyba pri generovaní (${code}): ${msg}`);
    }

    const first = Array.isArray(data?.choices) ? data.choices[0] : null;
    let text = first?.message?.content?.trim() || data?.output_text || "";
    if (!text) text = "Skús to napísať kratšie (do 8 slov).";
    const msg = SAFE(text).slice(0, MAX_CHARS);

    if (autoMode && /^skip$/i.test(msg)) return res.status(204).send();
    return res.status(200).send(msg);
  } catch {
    if (autoMode) return res.status(204).send();
    const quick = LANG === "sk"
      ? "Skús to prosím napísať kratšie (do 8 slov)."
      : LANG === "cz"
        ? "Zkus to prosím napsat kratší (do 8 slov)."
        : "Please write it shorter (up to 8 words).";
    return res.status(200).send(quick.slice(0, MAX_CHARS));
  }
}
