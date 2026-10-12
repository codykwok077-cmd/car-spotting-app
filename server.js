import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.set("trust proxy", 1); // Render sits behind a proxy; needed for real client IPs
app.use(express.json({ limit: "8mb" }));
app.use(express.static(path.join(__dirname, "public")));

const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6";
const DAILY_LIMIT = Number(process.env.SCANS_PER_IP_PER_DAY || 10);
const RARITIES = ["Common", "Uncommon", "Rare", "Epic", "Legendary", "Mythic"];

// Simple in-memory per-IP daily limit so a public deploy can't drain your API credit.
const hits = new Map();
function allow(ip) {
  const day = new Date().toISOString().slice(0, 10);
  const key = `${ip}:${day}`;
  const n = (hits.get(key) || 0) + 1;
  hits.set(key, n);
  if (hits.size > 5000) {
    for (const k of hits.keys()) if (!k.endsWith(day)) hits.delete(k);
  }
  return n <= DAILY_LIMIT;
}

const SYSTEM = `You identify cars from photos for a car-spotting collectible card game.
Reply with ONE JSON object and nothing else (no prose, no code fences).

If the photo does not clearly show a real car, reply {"is_car": false}.

Otherwise reply with exactly these keys:
{
  "is_car": true,
  "make": "Brand, e.g. BMW",
  "model": "Model name, e.g. M4 CSL",
  "generation": "Generation or chassis code if known, else empty string",
  "year": "Production years of this generation, e.g. 2022-2023",
  "body": "e.g. Coupe, Hatchback, SUV",
  "engine": "e.g. 3.0L twin-turbo inline-6",
  "power_hp": number or null,
  "zero_to_100_s": number or null,
  "top_speed_kmh": number or null,
  "rarity": one of ${JSON.stringify(RARITIES)},
  "rarity_reason": "One short sentence on why",
  "value_usd": { "low": number, "high": number },
  "fun_fact": "One short, true sentence",
  "confidence": number between 0 and 1
}

Rarity guide: Common = mass-market daily drivers. Uncommon = premium or enthusiast
variants. Rare = high-performance or low-volume models. Epic = exotics and
homologation specials. Legendary = limited-run supercars and iconic classics.
Mythic = hypercars and ultra-limited or priceless collector cars.
value_usd is a rough typical used-market range for this model and generation.
If you are unsure of the exact variant, give your best guess and lower the confidence.`;

function parseDataUrl(s) {
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(s || "");
  return m ? { media_type: m[1], data: m[2] } : null;
}

function extractJson(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("no json");
  return JSON.parse(text.slice(start, end + 1));
}

const str = (v, max = 120) => String(v ?? "").slice(0, max);
const num = (v) => (Number.isFinite(Number(v)) && v !== null && v !== "" ? Number(v) : null);

app.post("/api/identify", async (req, res) => {
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: "Server is missing ANTHROPIC_API_KEY." });
  }
  const img = parseDataUrl(req.body?.image);
  if (!img) return res.status(400).json({ error: "Send a JPEG, PNG or WebP image." });
  if (!allow(req.ip)) {
    return res.status(429).json({ error: "Daily scan limit reached. Come back tomorrow." });
  }

  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 700,
        system: SYSTEM,
        messages: [
          {
            role: "user",
            content: [
              { type: "image", source: { type: "base64", ...img } },
              { type: "text", text: "Identify this car." },
            ],
          },
        ],
      }),
    });

    if (!r.ok) {
      console.error("Anthropic API error", r.status, await r.text());
      return res.status(502).json({ error: "The identifier is unavailable. Try again shortly." });
    }

    const body = await r.json();
    const text = (body.content || []).map((b) => b.text || "").join("");
    const d = extractJson(text);
    if (!d.is_car) return res.json({ is_car: false });

    const low = num(d.value_usd?.low);
    const high = num(d.value_usd?.high);
    res.json({
      is_car: true,
      make: str(d.make, 40),
      model: str(d.model, 60),
      generation: str(d.generation, 40),
      year: str(d.year, 20),
      body: str(d.body, 30),
      engine: str(d.engine, 60),
      power_hp: num(d.power_hp),
      zero_to_100_s: num(d.zero_to_100_s),
      top_speed_kmh: num(d.top_speed_kmh),
      rarity: RARITIES.includes(d.rarity) ? d.rarity : "Common",
      rarity_reason: str(d.rarity_reason, 160),
      value_usd: { low: low ?? 0, high: high ?? low ?? 0 },
      fun_fact: str(d.fun_fact, 200),
      confidence: Math.min(1, Math.max(0, num(d.confidence) ?? 0.5)),
    });
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: "Could not read the identification result. Try another photo." });
  }
});

app.get("/healthz", (_req, res) => res.send("ok"));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Cardex running on :${port}`));
