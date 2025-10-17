export default async function handler(req, res) {
  // 1) Ultra-odolné vytiahnutie textu z URL (SE/Nightbot/holý querystring)
  function getUserText(req) {
    try {
      const q = req.query || {};
      const keys = ["prompt", "query", "text", "message", "msg", "q"];

      // a) pomenované parametre
      for (const k of keys) {
        const v = q[k];
        if (typeof v === "string" && v.trim()) return v;
      }

      // b) holý querystring: ?tvoj%20text  (kľúč je vlastne text)
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
      } catch (e) { /* ignore */ }

      return "";
    } catch (e) {
      return "";
    }
  }

  let raw = getUserText(req);

  // 2) Dvojité dekódovanie (SE vie poslať double-encoded) + fix na '+'
  let decoded = raw || "";
  try { decoded = decodeURIComponent(decoded); } catch (e) {}
  try { decoded = decodeURIComponent(decoded); } catch (e) {}
  decoded = decoded.replace(/\+/g, " "); // dôležité pre SE

  const prompt = (decoded || "")
    .toString()
    .slice(0, 600)
    .replace(/@\w+/g, "")
    .replace(/\s+/g, " ")
    .trim();

  // DEBUG režim: vráť, čo endpoint reálne dostal (bez volania OpenAI)
  if (req.query && String(req.query.debug) === "1") {
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

  // 3) Konfigurácia
  const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
  const LANG = process.env.BOT_LANG || "sk";
  const MAX_CHARS = Number(process.env.MAX_CHARS || 180);
  const TONE = process.env.BOT_TONE || "vtipný, priateľský, stručný";
  const STREAMER = process.env.STREAMER_NAME || "streamer";
  const GAME = process.env.STREAM_GAME || "Twitch";
  const SAFE = (s) => s.replace(/https?:\/\/\S+/gi, "[link]").replace(/(.+)\1{2,}/g, "$1");

  const isQuestion = /^[\s]*\?/.test(prompt) || /(prečo|ako|čo|what|why|how)/i.test(prompt);
  const temperature = isQuestion ? 0.4 : Number(process.env.TEMPERATURE || 0.6);

  const systemPrompt = [
    `Si Twitch chatbot na kanáli ${STREAMER}, odpovedaj vecne a v slovenčine.`,
    `Používaj ${TONE}. Max ${MAX_CHARS} znakov.`,
    "Odpovedaj jasne a priamo (1–2 vety).",
    "Ak otázka nedáva zmysel, odpovedz neutrálne bez filozofovania.",
    "Pri vede/hrach bež fakticky a krátko.",
    "Nezačínaj ospravedlnením a nepíš 'neviem čo myslíš'.",
    `Kontext: hráme ${GAME}, komunita je priateľská.`
  ].join(" ");

  try {
    // --- FAST payload: krátke odpovede pre SE ---
    const payload = {
      model: MODEL,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: prompt || "Pozdrav chat a predstav sa jednou vetou." }
      ]
    };

    // GPT-5: nový názov + bez temperature; GPT-4: klasika
    if (MODEL.startsWith("gpt-5")) {
      payload.max_completion_tokens = 60; // krátke = rýchle pre SE
      // temperature sa pre gpt-5 neposiela (default je 1)
    } else {
      payload.max_tokens = 60;
      payload.temperature = temperature;
    }

    // --- 850 ms timeout (SE má prísny limit) ---
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 850);

    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload),
      signal: ctrl.signal
    }).finally(() => clearTimeout(t));

    // Ak padne na chybe (401/429/…)
    if (!r.ok) {
      const data = await r.json().catch(() => ({}));
      const code = data?.error?.code || r.status;
      const msg  = data?.error?.message || "Neznáma chyba OpenAI.";
      return res.status(500).send(`🤖 Chyba pri generovaní (${code}): ${msg}`);
    }

    // OK → vráť odpoveď
    let out = (await r.json())?.choices?.[0]?.message?.content || "";
    out = (out.trim() || "Skús to prosím napísať kratšie (do 8 slov).");
    out = SAFE(out).slice(0, MAX_CHARS);
    return res.status(200).send(out);

  } catch (e) {
    // Timeout/sieť → ultra-rýchly faktický fallback
    const p = (prompt || "").toLowerCase();
    const quick =
      /ľadovc|ladovc/.test(p)
        ? "Ľadovce sa topia hlavne kvôli globálnemu otepľovaniu a skleníkovým plynom."
        : "Skús to prosím napísať kratšie (do 8 slov).";
    return res.status(200).send(quick.slice(0, MAX_CHARS));
  }
}

