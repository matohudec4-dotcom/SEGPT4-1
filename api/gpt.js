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
      } catch (e) {
        // ignore
      }
      return "";
    } catch (e) {
      return "";
    }
  }

  let raw = getUserText(req);

  // 2) Dvojité dekódovanie (SE niekedy posiela double-encoded)
  let decoded = raw || "";
  try { decoded = decodeURIComponent(decoded); } catch (e) {}
  try { decoded = decodeURIComponent(decoded); } catch (e) {}

  const prompt = (decoded || "")
    .toString()
    .slice(0, 600)
    .replace(/@\w+/g, "")
    .replace(/\s+/g, " ")
    .trim();

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

  const isQuestion = /^[\s]*\?/.test(prompt) || /(prečo|ako|what|why|how)/i.test(prompt);
  const temperature = isQuestion ? 0.3 : Number(process.env.TEMPERATURE || 0.5);

  const systemPrompt = [
    `Si Twitch co-host bota kanála ${STREAMER}.`,
    `Hovor jazykom: ${LANG}. Buď ${TONE}. Max ${MAX_CHARS} znakov.`,
    "Buď stručný (1–2 vety), bez odsekov, bez # a bez @mention.",
    "Ak niečo nevieš, povedz to priamo. Žiadne vymýšľanie faktov.",
    "Ak je dopyt toxický/NSFW/spam, zdvorilo odmietni a navrhni inú tému.",
    `Kontext: hráme ${GAME}, komunita je priateľská.`
  ].join(" ");

  try {
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: prompt || "Pozdrav chat a predstav sa jednou vetou." }
        ],
        max_tokens: 120,
        temperature
      })
    });

    const data = await r.json();
    if (!r.ok) {
      const code = (data && data.error && data.error.code) ? data.error.code : r.status;
      const msg  = (data && data.error && data.error.message) ? data.error.message : "Neznáma chyba OpenAI.";
      return res.status(500).send(`🤖 Chyba pri generovaní (${code}): ${msg}`);
    }

    let out = (data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || "";
    out = (out.trim() || "Hmm, skús to inak. 🙂");
    out = SAFE(out).slice(0, MAX_CHARS);
    return res.status(200).send(out);
  } catch (e) {
    return res.status(500).send("❌ Server error – skontroluj Logs v Vercel Deployments.");
  }
}
