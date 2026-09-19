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
const CHECK_CRON = process.env.CHECK_CRON || "*/1 * * * *";
const MANUAL_CHECK_MIN_INTERVAL_MS = Number(process.env.MANUAL_CHECK_MIN_INTERVAL_MS || 30000);
const STATE_KEY = process.env.STATE_KEY || "kaitori:prices";
const APP_VERSION = "2026-09-19-auto-refresh-v3";
const PRICE_MAX_AGE_MS = Number(process.env.PRICE_MAX_AGE_MS || 60000);
const AUTO_REFRESH_ON_READ = process.env.AUTO_REFRESH_ON_READ !== "false";
const ENABLE_INTERNAL_CRON = process.env.ENABLE_INTERNAL_CRON == null
  ? !process.env.VERCEL
  : process.env.ENABLE_INTERNAL_CRON === "true";
let runningCheck = null;
let lastManualCheckAt = 0;
let memoryState = null;

app.use(express.json());
app.use((req, res, next) => {
  res.set("Content-Security-Policy", "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'self'; form-action 'self'; frame-ancestors 'none'");
  res.set("X-Content-Type-Options", "nosniff");
  res.set("Referrer-Policy", "strict-origin-when-cross-origin");
  res.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  next();
});
app.use("/api", (req, res, next) => {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");
  next();
});
app.use(express.static(path.join(__dirname, "public")));

function loadJSON(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    console.error(`Cannot read JSON file ${path.basename(file)}:`, e.message);
    return fallback;
  }
}

function saveJSON(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
}

function hasRedisStore() {
  return Boolean(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);
}

async function redisCommand(command) {
  const { data } = await axios.post(process.env.UPSTASH_REDIS_REST_URL, command, {
    timeout: 10000,
    headers: {
      Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}`,
      "Content-Type": "application/json"
    }
  });

  if (data?.error) {
    throw new Error(data.error);
  }
  return data?.result;
}

async function loadState() {
  if (hasRedisStore()) {
    try {
      const value = await redisCommand(["GET", STATE_KEY]);
      return value ? JSON.parse(value) : { rows: [], updatedAt: null, errors: [] };
    } catch (e) {
      console.error("Cannot read price state from Redis:", e.message);
    }
  }
  if (memoryState) return memoryState;
  return loadJSON(DATA_FILE, { rows: [], updatedAt: null, errors: [] });
}

async function saveState(state) {
  if (hasRedisStore()) {
    await redisCommand(["SET", STATE_KEY, JSON.stringify(state)]);
    return;
  }
  memoryState = state;
  try {
    saveJSON(DATA_FILE, state);
  } catch (e) {
    console.error("Cannot write local price state:", e.message);
  }
}

function parseYen(value = "") {
  const text = String(value)
    .replace(/[,\s\u00a0]/g, "")
    .replace(/[\uffe5]/g, "\u00a5")
    .replace(/\u5186/g, "\u00a5");
  const match = text.match(/\u00a5?(\d{4,9})\u00a5?/);
  if (!match) return null;
  const price = Number(match[1]);
  return Number.isFinite(price) && price >= 10000 && price <= 2000000 ? price : null;
}

function normalizeName(text = "") {
  return String(text)
    .replace(/\s+/g, " ")
    .replace(/【.*?】|\[.*?\]|\(.*?\)/g, "")
    .trim();
}

function productKey(model, storage) {
  const normalizedModel = normalizeName(model).toLowerCase().replace(/\s+/g, "");
  return `${normalizedModel}-${String(storage).toLowerCase()}`;
}

function inferProduct(name = "") {
  const clean = normalizeName(name);
  const model = clean.match(/iPhone\s*18\s*(?:Pro\s*Max|Pro|Plus|Air|e)?/i)?.[0]?.replace(/\s+/g, " ");
  const storage = clean.match(/\b(?:128|256|512)GB\b|\b(?:1|2)TB\b/i)?.[0]?.toUpperCase();
  if (!model || !storage) return null;
  return { model, storage, key: productKey(model, storage) };
}

async function fetchHtml(url) {
  const res = await axios.get(withCacheBust(url), {
    timeout: 20000,
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/153 Safari/537.36",
      "Accept-Language": "ja,en;q=0.9,vi;q=0.8",
      "Cache-Control": "no-cache",
      "Pragma": "no-cache"
    }
  });
  return res.data;
}

function withCacheBust(url) {
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}_=${Date.now()}`;
}

function extractProductsFromText(text, source) {
  const products = [];
  const lines = String(text).replace(/\r/g, "\n").split("\n").map(x => x.trim()).filter(Boolean);

  for (let i = 0; i < lines.length; i += 1) {
    const inferred = inferProduct(lines[i]);
    if (!inferred) continue;
    const nearby = lines.slice(i, i + 8).join(" ");
    const prices = [...nearby.matchAll(/[\u00a5\uffe5]?\s?[\d,]{5,9}\s?(?:\u5186|\u00a5|\uffe5)?/g)]
      .map(match => parseYen(match[0]))
      .filter(Boolean);
    if (!prices.length) continue;
    products.push({
      ...inferred,
      shop: source.shop,
      sourceId: source.id,
      sourceType: source.type,
      url: source.url,
      price: source.type === "apple" ? Math.min(...prices) : Math.max(...prices)
    });
  }

  return products;
}

function extractProductsFromHtml(html, source) {
  const $ = cheerio.load(html);
  const products = [];

  $("tr, li, article, .item, .product, .product-item, .p-product, .price-list__item").each((_, el) => {
    const text = $(el).text().replace(/\s+/g, " ").trim();
    const inferred = inferProduct(text);
    if (!inferred) return;
    const prices = [...text.matchAll(/[\u00a5\uffe5]?\s?[\d,]{5,9}\s?(?:\u5186|\u00a5|\uffe5)?/g)]
      .map(match => parseYen(match[0]))
      .filter(Boolean);
    if (!prices.length) return;
    products.push({
      ...inferred,
      shop: source.shop,
      sourceId: source.id,
      sourceType: source.type,
      url: source.url,
      price: source.type === "apple" ? Math.min(...prices) : Math.max(...prices)
    });
  });

  if (!products.length) {
    return extractProductsFromText($("body").text(), source);
  }
  return products;
}

async function scrapeSource(source) {
  if (source.type === "manual") {
    return (source.products || []).map(item => ({
      ...inferProduct(`${item.model} ${item.storage}`),
      model: item.model,
      storage: item.storage,
      shop: source.shop,
      sourceId: source.id,
      sourceType: source.as || "apple",
      url: item.url || source.url,
      price: Number(item.price)
    })).filter(item => item.key && item.price);
  }

  if (source.adapter === "kaitorishouten") {
    return scrapeKaitoriShouten(source);
  }

  if (source.adapter === "onechome") {
    return scrapeOneChome(source);
  }

  if (source.adapter === "pastec") {
    return scrapePastec(source);
  }

  const html = await fetchHtml(source.url);
  return extractProductsFromHtml(html, source);
}

function priceFromKaitoriShoutenItem(item) {
  const direct = Number(item?.price_new?.amount);
  if (Number.isFinite(direct) && direct > 0) return direct;
  const prices = (item?.prices || [])
    .map(price => Number(price.amount))
    .filter(price => Number.isFinite(price) && price > 0);
  return prices.length ? Math.max(...prices) : null;
}

function compactProducts(products) {
  const byKey = new Map();
  for (const product of products) {
    if (!product.key || !product.price) continue;
    const current = byKey.get(product.key);
    if (!current || product.price > current.price) {
      byKey.set(product.key, product);
    }
  }
  return [...byKey.values()];
}

async function scrapeKaitoriShouten(source) {
  const categoryIds = source.categoryIds || [];
  const products = [];

  for (const categoryId of categoryIds) {
    const url = `https://www.kaitorishouten-co.jp/api/v1/products?per_page=100&page=1&category_id=${encodeURIComponent(categoryId)}`;
    const { data } = await axios.get(withCacheBust(url), {
      timeout: 20000,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/153 Safari/537.36",
        "Accept": "application/json",
        "Referer": source.url,
        "Cache-Control": "no-cache",
        "Pragma": "no-cache"
      }
    });

    for (const item of data?.items || []) {
      const inferred = inferProduct(item.name);
      const price = priceFromKaitoriShoutenItem(item);
      if (!inferred || !price) continue;
      products.push({
        ...inferred,
        shop: source.shop,
        sourceId: source.id,
        sourceType: source.type,
        url: `${source.url}?category_id=${categoryId}`,
        price
      });
    }
  }

  return compactProducts(products);
}

function priceFromOneChomeItem(item) {
  const detailPrices = (item?.goodsKbDetails || [])
    .map(detail => Number(detail.kbDetailPrice ?? detail.maxPrice))
    .filter(price => Number.isFinite(price) && price > 0);
  return detailPrices.length ? Math.max(...detailPrices) : null;
}

async function scrapeOneChome(source) {
  const keywords = source.keywords || ["iPhone 18 Pro", "iPhone 18 Pro Max"];
  const products = [];

  for (const keyword of keywords) {
    const url = `https://www.1-chome.com/api/index/findByKeyword?page=1&size=48&keyword=${encodeURIComponent(keyword)}`;
    const { data } = await axios.get(withCacheBust(url), {
      timeout: 20000,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/153 Safari/537.36",
        "Accept": "application/json",
        "Referer": source.url,
        "Cache-Control": "no-cache",
        "Pragma": "no-cache"
      }
    });

    for (const item of data?.data?.content || []) {
      const inferred = inferProduct(item.title);
      const price = priceFromOneChomeItem(item);
      if (!inferred || !price) continue;
      products.push({
        ...inferred,
        shop: source.shop,
        sourceId: source.id,
        sourceType: source.type,
        url: source.url,
        price
      });
    }
  }

  return compactProducts(products);
}

async function scrapePastec(source) {
  const html = await fetchHtml(source.url);
  const $ = cheerio.load(html);
  const bodyText = $("body").text().replace(/\s+/g, " ").trim();
  const chunks = bodyText.split(/(?=iPhone\s*18\s*(?:Pro\s*Max|Pro))/gi);
  const products = [];
  const seen = new Set();

  for (const chunk of chunks) {
    const productMatch = chunk.match(/iPhone\s*18\s*(?:Pro\s*Max|Pro)\s*(?:128|256|512|1|2)TB?/i);
    if (!productMatch) continue;

    const inferred = inferProduct(productMatch[0]);
    if (!inferred) continue;

    const prices = [...chunk.matchAll(/[\u00a5\uffe5]?\s?[\d,]{4,9}\s?(?:\u5186|\u00a5|\uffe5)?/g)]
      .map(match => parseYen(match[0]))
      .filter(Boolean);

    const price = prices.length ? Math.max(...prices) : null;
    if (!price) continue;

    const key = `${inferred.key}:${price}`;
    if (seen.has(key)) continue;
    seen.add(key);

    products.push({
      ...inferred,
      shop: source.shop,
      sourceId: source.id,
      sourceType: source.type,
      url: source.url,
      price
    });
  }

  if (!products.length) {
    const fallback = [...bodyText.matchAll(/iPhone\s*18\s*(?:Pro\s*Max|Pro)\s*(?:128|256|512|1|2)TB?[^\n]{0,120}([\u00a5\uffe5]?\s?[\d,]{4,9}\s?(?:\u5186|\u00a5|\uffe5)?)/gi)]
      .map(match => {
        const inferred = inferProduct(match[0]);
        const price = parseYen(match[1]);
        return inferred && price ? { ...inferred, shop: source.shop, sourceId: source.id, sourceType: source.type, url: source.url, price } : null;
      })
      .filter(Boolean);

    return compactProducts([...products, ...fallback]);
  }

  return compactProducts(products);
}

function buildComparison(scraped, previousRows = []) {
  const apple = new Map();
  const offers = [];

  for (const item of scraped) {
    if (item.sourceType === "apple") {
      apple.set(item.key, item);
    } else {
      offers.push(item);
    }
  }

  const previousById = new Map(previousRows.map(row => [row.id, row]));

  return offers.map(offer => {
    const base = apple.get(offer.key);
    const applePrice = base?.price ?? null;
    const profit = applePrice == null ? null : offer.price - applePrice;
    const id = `${offer.sourceId}:${offer.key}`;
    const previous = previousById.get(id);
    return {
      id,
      key: offer.key,
      model: offer.model,
      storage: offer.storage,
      shop: offer.shop,
      sourceId: offer.sourceId,
      url: offer.url,
      buyPrice: offer.price,
      applePrice,
      appleUrl: base?.url || null,
      profit,
      previousBuyPrice: previous?.buyPrice ?? null,
      previousProfit: previous?.profit ?? null,
      checkedAt: new Date().toISOString()
    };
  }).sort((a, b) => (b.profit ?? -Infinity) - (a.profit ?? -Infinity));
}

function mergeRowsWithStalePrevious(rows, previousRows = [], errors = []) {
  const nextById = new Map(rows.map(row => [row.id, row]));
  const failedSourceIds = new Set(errors.map(error => error.id).filter(Boolean));

  for (const row of previousRows) {
    if (!failedSourceIds.has(row.sourceId) || nextById.has(row.id)) continue;
    const error = errors.find(item => item.id === row.sourceId);
    nextById.set(row.id, {
      ...row,
      stale: true,
      staleReason: error?.error || "Source failed during the latest check"
    });
  }

  return [...nextById.values()].sort((a, b) => (b.profit ?? -Infinity) - (a.profit ?? -Infinity));
}

function isCronAuthorized(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  const header = req.get("authorization") || "";
  return header === `Bearer ${secret}` || req.query.token === secret;
}

async function sendDiscord(message, embeds = []) {
  const url = process.env.DISCORD_WEBHOOK_URL;
  if (!url) return;
  await axios.post(url, { content: message, embeds, allowed_mentions: { parse: [] } });
}

async function checkPrices({ manual = false } = {}) {
  const config = loadJSON(SOURCES_FILE, { sources: [] });
  const sources = (Array.isArray(config) ? config : config.sources || []).filter(s => s.enabled);
  const previous = await loadState();
  const scraped = [];
  const errors = [];

  const results = await Promise.allSettled(sources.map(async source => ({
    source,
    products: await scrapeSource(source)
  })));

  for (const result of results) {
    if (result.status === "fulfilled") {
      scraped.push(...result.value.products);
    } else {
      const source = result.reason?.source || sources[results.indexOf(result)] || {};
      const e = result.reason?.error || result.reason;
      errors.push({ id: source.id, shop: source.shop, url: source.url, error: e?.message || String(e) });
    }
  }

  const freshRows = buildComparison(scraped, previous.rows || []);
  const rows = mergeRowsWithStalePrevious(freshRows, previous.rows || [], errors);
  const state = { rows, updatedAt: new Date().toISOString(), errors };
  await saveState(state);

  const changed = rows.filter(row =>
    row.previousBuyPrice !== null &&
    (row.previousBuyPrice !== row.buyPrice || row.previousProfit !== row.profit)
  );

  if (changed.length) {
    const lines = changed.slice(0, 10).map(row => {
      const profitLabel = row.profit == null ? "Loi nhuan: N/A" : `Loi nhuan: ${row.profit >= 0 ? "+" : ""}JPY ${row.profit.toLocaleString("ja-JP")}`;
      return [
        `${row.model} ${row.storage}`,
        `Shop: ${row.shop}`,
        `Mua: JPY ${row.buyPrice.toLocaleString("ja-JP")}`,
        `Apple: ${row.applePrice ? `JPY ${row.applePrice.toLocaleString("ja-JP")}` : "N/A"}`,
        profitLabel,
        `Link: ${row.url}`,
        ""
      ].join("\n");
    });
    await sendDiscord(lines.join("\n"));
  } else if (manual) {
    await sendDiscord("Checked iPhone 18 kaitori prices. No changes.");
  }

  return { ok: true, ...state };
}

function runPriceCheck(options = {}) {
  if (!runningCheck) {
    runningCheck = checkPrices(options).finally(() => {
      runningCheck = null;
    });
  }
  return runningCheck;
}

function isStateStale(state) {
  if (!state?.updatedAt) return true;
  const updatedAt = new Date(state.updatedAt).getTime();
  return !Number.isFinite(updatedAt) || Date.now() - updatedAt > PRICE_MAX_AGE_MS;
}

app.get("/api/prices", async (req, res) => {
  try {
    const state = await loadState();
    if (AUTO_REFRESH_ON_READ && (req.query.refresh === "1" || isStateStale(state))) {
      res.json(await runPriceCheck());
      return;
    }
    res.json(state);
  } catch (e) {
    res.status(500).json({ rows: [], updatedAt: null, errors: [{ error: e?.message || String(e) }] });
  }
});

app.get("/api/sources", (req, res) => {
  res.json(loadJSON(SOURCES_FILE, { sources: [] }));
});

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    version: APP_VERSION,
    store: hasRedisStore() ? "upstash-redis" : "memory-file-fallback",
    stateKey: STATE_KEY,
    internalCron: ENABLE_INTERNAL_CRON,
    autoRefreshOnRead: AUTO_REFRESH_ON_READ,
    priceMaxAgeMs: PRICE_MAX_AGE_MS,
    vercel: Boolean(process.env.VERCEL),
    hasRedisUrl: Boolean(process.env.UPSTASH_REDIS_REST_URL),
    hasRedisToken: Boolean(process.env.UPSTASH_REDIS_REST_TOKEN)
  });
});

async function handleManualCheck(req, res) {
  try {
    const now = Date.now();
    if (now - lastManualCheckAt < MANUAL_CHECK_MIN_INTERVAL_MS) {
      res.status(429).json({ ok: false, error: "Please wait before checking again." });
      return;
    }
    lastManualCheckAt = now;
    res.json(await runPriceCheck({ manual: true }));
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
}

app.get("/api/check", handleManualCheck);
app.post("/api/check", handleManualCheck);

app.get("/api/cron/check-prices", async (req, res) => {
  if (!isCronAuthorized(req)) {
    res.status(401).json({ ok: false, error: "Unauthorized" });
    return;
  }

  try {
    res.json(await runPriceCheck());
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

if (ENABLE_INTERNAL_CRON) {
  cron.schedule(CHECK_CRON, () => {
    runPriceCheck().catch(err => console.error("Cron check error:", err));
  });

  runPriceCheck().catch(err => console.error("Initial check error:", err));
}

app.listen(PORT, () => {
  console.log(`Kaitori bot running: http://localhost:${PORT}`);
  console.log(`Internal cron: ${ENABLE_INTERNAL_CRON ? CHECK_CRON : "disabled"}`);
});
