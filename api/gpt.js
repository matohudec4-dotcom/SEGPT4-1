export default async function handler(req, res) {
  // ── 1) Vstup + dekódovanie z StreamElements ($(querystring)) ─────────────
// 1) Ultra-odolné vytiahnutie textu z URL (SE/Nightbot/holý querystring)
const getUserText = (req) => {
  // Next.js štýl (req.query)
  const q = req.query || {};
  const keyOrder = ["prompt", "query", "text", "message", "msg", "q"];

  // 1) Pomenované parametre
  for (const k of keyOrder) {
    if (typeof q[k] === "string" && q[k].trim()) return q[k];
  }

  // 2) Jediný „holý“ parameter: ?tvoj%20text (kľúč je vlastne text)
  const keys = Object.keys(q);
  if (keys.length === 1 && (q[keys[0]] === "" || typeof q[keys[0]] === "undefined")) {
    return keys[0];
  }

  // 3) Fallback: rozparsuj URL manuálne
  try {
    const u = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const sp = u.searchParams;

    for (const k of keyOrder) {
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
};

let raw = getUserText(req);

// Dvojité dekódovanie s ochranou (SE vie poslať double-encoded)
let decoded = raw || "";
try { decoded = decodeURIComponent(decoded); } catch (_) {}
try { decoded = decodeURIComponent(decoded); } catch (_) {}

const prompt = (decoded || "")
  .toString()
  .slice(0, 600)
  .replace(/@\w+/g, "")
  .replace(/\s+/g, " ")
  .trim();

if (!process.env.OPENAI_API_KEY) {
  return res.status(500).send("❌ OPENAI_API_KEY chýba vo Vercel → Settings → Environment Variables.");
}


    // nič – prázdny vstup
    return "";
  } catch {
    return "";
  }
};

const raw = getUserText(req);
const prompt = decodeURIComponent(raw).toString().slice(0, 600)
  .replace(/@\w+/g, "")
  .replace(/\s+/g, " ")
  .trim();

if (!process.env.OPENAI_API_KEY) {
  return res.status(500).send("❌ OPENAI_API_KEY chýba vo Vercel → Settings → Environment Variables.");
}


  // ── 2) Konfig cez ENV (ľahké doladenie bez úpravy kódu) ──────────────────
  const MODEL = process.env.OPENAI_MODEL || "gpt-4o";
  const LANG = process.env.BOT_LANG || "sk";
  const MAX_CHARS = Number(process.env.MAX_CHARS || 350);
  const TONE = process.env.BOT_TONE || "vtipný, priateľský, stručný";
  const STREAMER = process.env.STREAMER_NAME || "Sokrat";
  const GAME = process.env.STREAM_GAME || "Twitch";
  const SAFE = (s) =>
    s.replace(/https?:\/\/\S+/gi, "[link]").replace(/(.+)\1{2,}/g, "$1");

  const isQuestion = /^[\s]*\?/.test(prompt) || /(prečo|ako|what|why|how)/i.test(prompt);
  const temperature = isQuestion ? 0.3 : Number(process.env.TEMPERATURE || 0.5);

  // ── 3) Persona pre chat (system prompt) ──────────────────────────────────
  const systemPrompt = [
    `Si Twitch co-host bota kanála ${STREAMER}.`,
    `Hovor jazykom: ${LANG}. Buď ${TONE}. Max ${MAX_CHARS} znakov.`,
    "Buď stručný (1–2 vety), bez odsekov, bez #, bez @mention.",
    "Ak sa pýtajú na pravidlá alebo info o streame, odpovedz stručne a pomocne.",
    "Keď niečo nevieš, povedz to priamo. Žiadne vymýšľanie faktov.",
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
      const code = data?.error?.code || r.status;
      const msg = data?.error?.message || "Neznáma chyba OpenAI.";
      return res.status(500).send(`🤖 Chyba pri generovaní (${code}): ${msg}`);
    }

    let out = (data?.choices?.[0]?.message?.content || "").trim();
    if (!out) out = "Hmm, skús to inak. 🙂";
    out = SAFE(out).slice(0, MAX_CHARS);
    return res.status(200).send(out);
  } catch (e) {
    return res.status(500).send("❌ Server error – skontroluj Logs v Vercel Deployments.");
  }
}
