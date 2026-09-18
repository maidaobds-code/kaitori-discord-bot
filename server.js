
import express from "express";
import axios from "axios";
import * as cheerio from "cheerio";
import cron from "node-cron";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = Number(process.env.PORT || 3000);
const DATA_FILE = path.join(__dirname, "data", "prices.json");
const SOURCES_FILE = path.join(__dirname, "sources.json");

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

function loadJSON(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function saveJSON(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
}

function parseYen(text = "") {
  const normalized = text.replace(/[,\s]/g, "");
  const matches = normalized.match(/(?:¥|￥)?(\d{4,9})円?/g) || [];
  const nums = matches
    .map(x => Number((x.match(/\d+/g) || []).join("")))
    .filter(n => Number.isFinite(n) && n >= 10000 && n <= 2000000);
  if (!nums.length) return null;
  return Math.max(...nums);
}

async function scrapeSource(source) {
  const res = await axios.get(source.url, {
    timeout: 15000,
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/153 Safari/537.36"
    }
  });

  const $ = cheerio.load(res.data);
  let text = "";
  if (source.priceSelector) {
    text = $(source.priceSelector).first().text();
  }
  if (!text.trim()) {
    text = $("body").text();
  }
  const price = parseYen(text);
  if (!price) throw new Error("Không tìm thấy giá hợp lệ. Kiểm tra priceSelector.");
  return price;
}

async function sendDiscord(message, embeds = []) {
  const url = process.env.DISCORD_WEBHOOK_URL;
  if (!url) return;
  await axios.post(url, {
    content: message,
    embeds,
    allowed_mentions: { parse: [] }
  });
}

async function checkPrices({ manual = false } = {}) {
  const sources = loadJSON(SOURCES_FILE, []).filter(s => s.enabled);
  const state = loadJSON(DATA_FILE, { items: {}, updatedAt: null });
  const changes = [];
  const errors = [];

  for (const source of sources) {
    try {
      const newPrice = await scrapeSource(source);
      const old = state.items[source.id]?.price ?? null;

      state.items[source.id] = {
        ...source,
        price: newPrice,
        previousPrice: old,
        checkedAt: new Date().toISOString()
      };

      if (old !== null && old !== newPrice) {
        changes.push({
          ...source,
          oldPrice: old,
          newPrice
        });
      }
    } catch (e) {
      errors.push({
        id: source.id,
        shop: source.shop,
        error: e?.message || String(e)
      });
    }
  }

  state.updatedAt = new Date().toISOString();
  state.errors = errors;
  saveJSON(DATA_FILE, state);

  if (changes.length) {
    for (const c of changes) {
      const diff = c.newPrice - c.oldPrice;
      const arrow = diff > 0 ? "📈" : "📉";
      await sendDiscord(
        `${arrow} Giá kaitori đã thay đổi`,
        [{
          title: `${c.shop} — ${c.model} ${c.storage}`,
          url: c.url,
          fields: [
            { name: "Giá cũ", value: `¥${c.oldPrice.toLocaleString("ja-JP")}`, inline: true },
            { name: "Giá mới", value: `¥${c.newPrice.toLocaleString("ja-JP")}`, inline: true },
            { name: "Chênh lệch", value: `${diff >= 0 ? "+" : ""}¥${diff.toLocaleString("ja-JP")}`, inline: true }
          ],
          timestamp: new Date().toISOString()
        }]
      );
    }
  } else if (manual) {
    await sendDiscord("✅ Đã kiểm tra giá kaitori. Không có thay đổi.");
  }

  return { ok: true, changes, errors, state };
}

app.get("/api/prices", (req, res) => {
  res.json(loadJSON(DATA_FILE, { items: {}, updatedAt: null, errors: [] }));
});

app.get("/api/sources", (req, res) => {
  res.json(loadJSON(SOURCES_FILE, []));
});

app.post("/api/check", async (req, res) => {
  try {
    const result = await checkPrices({ manual: true });
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

const schedule = process.env.CHECK_CRON || "*/5 * * * *";
cron.schedule(schedule, () => {
  checkPrices().catch(err => console.error("Cron check error:", err));
});

app.listen(PORT, () => {
  console.log(`Kaitori bot đang chạy: http://localhost:${PORT}`);
  console.log(`Lịch kiểm tra: ${schedule}`);
});
