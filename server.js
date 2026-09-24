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
const IS_SERVERLESS_READONLY = __dirname.startsWith("/var/task") || Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);
const WRITABLE_STATE_DIR = process.env.WRITABLE_STATE_DIR || (IS_SERVERLESS_READONLY ? "/tmp" : path.join(__dirname, "data"));
const IS_CHECKER_STATE_FILE = process.env.IS_CHECKER_STATE_FILE || path.join(WRITABLE_STATE_DIR, "is-checker-price-state.json");
const SOURCES_FILE = path.join(__dirname, "sources.json");
const CHECK_CRON = process.env.CHECK_CRON || "*/1 * * * *";
const IS_CHECKER_URL = process.env.IS_CHECKER_URL || "https://is-checker.com/iphone18_beta.html";
const IS_CHECKER_CACHE_MS = Number(process.env.IS_CHECKER_CACHE_MS || 30000);
const PRICE_CHANGE_TTL_MS = 3 * 60 * 60 * 1000;
let runningCheck = null;
let isCheckerCache = null;

app.use(express.json());
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
  } catch {
    return fallback;
  }
}

function saveJSON(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
}

function parseYen(value = "") {
  const text = String(value).replace(/[,\s]/g, "");
  const match = text.match(/(?:¥|￥)?(\d{4,9})(?:円)?/);
  if (!match) return null;
  const price = Number(match[1]);
  return Number.isFinite(price) && price >= 10000 && price <= 2000000 ? price : null;
}

function normalizeName(text = "") {
  return String(text)
    .replace(/\s+/g, " ")
    .replace(/（.*?）|\(.*?\)|\[.*?\]/g, "")
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
    const prices = [...nearby.matchAll(/(?:¥|￥)?\s?[\d,]{5,9}\s?円?/g)]
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
    const prices = [...text.matchAll(/(?:¥|￥)?\s?[\d,]{5,9}\s?円?/g)]
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

  if (source.adapter === "mobilemix") {
    return scrapeMobileMix(source);
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

    const prices = [...chunk.matchAll(/(?:¥|￥)?\s?[\d,]{3,9}\s?円?/g)]
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
    const fallback = [...bodyText.matchAll(/iPhone\s*18\s*(?:Pro\s*Max|Pro)\s*(?:128|256|512|1|2)TB?[^\n]{0,120}([\d,]{3,9})円/gi)]
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

async function scrapeMobileMix(source) {
  const html = await fetchHtml(source.url);
  if (!html.includes('table class="list"')) {
    throw new Error("Mobile Mix did not return the price table (anti-bot or temporary page)");
  }
  const $ = cheerio.load(html);
  const products = [];

  $("table.list tr").each((_, row) => {
    const name = $(row).find('td.product[name="model"]').first().text().replace(/\s+/g, " ").trim();
    const inferred = inferProduct(name);
    const price = parseYen($(row).find("td.price").first().text());
    if (!inferred || !price) return;

    products.push({
      ...inferred,
      shop: source.shop,
      sourceId: source.id,
      sourceType: source.type,
      url: source.url,
      price
    });
  });

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

async function sendDiscord(message, embeds = []) {
  const url = process.env.DISCORD_WEBHOOK_URL;
  if (!url) return;
  await axios.post(url, { content: message, embeds, allowed_mentions: { parse: [] } });
}

async function checkPrices({ manual = false } = {}) {
  const config = loadJSON(SOURCES_FILE, { sources: [] });
  const sources = (Array.isArray(config) ? config : config.sources || []).filter(s => s.enabled);
  const previous = loadJSON(DATA_FILE, { rows: [] });
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

  const rows = buildComparison(scraped, previous.rows || []);
  const state = { rows, updatedAt: new Date().toISOString(), errors };
  saveJSON(DATA_FILE, state);

  const changed = rows.filter(row =>
    row.previousBuyPrice !== null &&
    (row.previousBuyPrice !== row.buyPrice || row.previousProfit !== row.profit)
  );

  if (changed.length) {
    const lines = changed.slice(0, 10).map(row => {
      const profitLabel = row.profit == null ? "Lợi nhuận: N/A" : `Lợi nhuận: ${row.profit >= 0 ? "+" : ""}¥${row.profit.toLocaleString("ja-JP")}`;
      return [
        `📉 ${row.model} ${row.storage}`,
        `Shop: ${row.shop}`,
        `Mua: ¥${row.buyPrice.toLocaleString("ja-JP")}`,
        `Apple: ${row.applePrice ? `¥${row.applePrice.toLocaleString("ja-JP")}` : "N/A"}`,
        profitLabel,
        `Link: ${row.url}`,
        ""
      ].join("\n");
    });
    await sendDiscord(lines.join("\n"));
  } else if (manual) {
    await sendDiscord("Checked iPhone 18 kaitori prices. No changes.");
  }

  return { ok: true, rows, errors };
}

function runPriceCheck(options = {}) {
  if (!runningCheck) {
    runningCheck = checkPrices(options).finally(() => {
      runningCheck = null;
    });
  }
  return runningCheck;
}

async function scrapeLivePrices() {
  const config = loadJSON(SOURCES_FILE, { sources: [] });
  const sources = (Array.isArray(config) ? config : config.sources || []).filter(source => source.enabled);
  const scraped = [];
  const errors = [];

  const results = await Promise.allSettled(sources.map(async source => ({
    source,
    products: await scrapeSource(source)
  })));

  results.forEach((result, index) => {
    if (result.status === "fulfilled") {
      scraped.push(...result.value.products);
      return;
    }

    const source = sources[index];
    errors.push({
      id: source.id,
      shop: source.shop,
      url: source.url,
      error: result.reason?.message || String(result.reason)
    });
  });

  return {
    ok: true,
    rows: buildComparison(scraped, []),
    updatedAt: new Date().toISOString(),
    errors
  };
}

function cleanCellText(value = "") {
  return String(value).replace(/\u00a0/g, " ").replace(/[ \t]+/g, " ").trim();
}

function sanitizeTableHtml(html = "") {
  const $ = cheerio.load(`<root>${html}</root>`, null, false);
  $("script,style,iframe,object,embed").remove();
  $("*").each((_, el) => {
    const node = $(el);
    for (const attr of Object.keys(el.attribs || {})) {
      if (attr.toLowerCase().startsWith("on") || attr.toLowerCase() === "style") {
        node.removeAttr(attr);
      }
    }
    if (node.is("a")) {
      const href = node.attr("href") || "";
      if (!/^https?:\/\//i.test(href)) node.removeAttr("href");
      node.attr("target", "_blank");
      node.attr("rel", "noopener noreferrer");
    }
  });
  return $("root").html() || "";
}

function parsePriceNumber(value = "") {
  const match = String(value).replace(/,/g, "").match(/\d{4,9}/);
  if (!match) return null;
  const price = Number(match[0]);
  return Number.isFinite(price) ? price : null;
}

function isCheckerPriceKey(row, cell) {
  return [row.kind, row.capacity, row.color, cell.shop].map(value => String(value || "").trim()).join("|");
}

function withSharedPriceChanges(rows) {
  const now = Date.now();
  const previousState = loadJSON(IS_CHECKER_STATE_FILE, { snapshot: {}, changes: {} });
  const nextSnapshot = {};
  const nextChanges = { ...(previousState.changes || {}) };

  rows.filter(row => !row.isUpdateRow).forEach(row => {
    row.cells.filter(cell => cell.shop).forEach(cell => {
      const price = parsePriceNumber(cell.text);
      if (price == null) return;
      const key = isCheckerPriceKey(row, cell);
      const previous = previousState.snapshot?.[key];
      nextSnapshot[key] = price;
      if (previous != null && Number(previous) !== price) {
        nextChanges[key] = now;
      }
    });
  });

  Object.keys(nextChanges).forEach(key => {
    if (nextSnapshot[key] == null || now - Number(nextChanges[key]) > PRICE_CHANGE_TTL_MS) {
      delete nextChanges[key];
    }
  });

  try {
    saveJSON(IS_CHECKER_STATE_FILE, {
      updatedAt: new Date(now).toISOString(),
      snapshot: nextSnapshot,
      changes: nextChanges
    });
  } catch (error) {
    console.warn(`Could not save is-checker price state: ${error?.message || error}`);
  }

  return nextChanges;
}

function columnKind($, el, label) {
  const node = $(el);
  const className = node.attr("class") || "";
  const shop = node.attr("data-shop") || null;
  if (shop || className.includes("shop-head") || className.includes("shop-cell")) {
    return { shop, store: null };
  }
  const store = node.attr("data-store") || node.attr("data-stock-key") || null;
  if (store || className.includes("stock-head") || className.includes("stock-cell")) {
    return { shop: null, store: store || label };
  }
  return { shop: null, store: null };
}

async function scrapeIsChecker() {
  const html = await fetchHtml(IS_CHECKER_URL);
  const $ = cheerio.load(html);
  const table = $("table.dataframe").first().length
    ? $("table.dataframe").first()
    : $("table").filter((_, el) => {
        const firstRowText = $(el).find("tr").first().text();
        return firstRowText.includes("\u7a2e\u5225")
          || (firstRowText.includes("\u5bb9\u91cf") && firstRowText.includes("\u5b9a\u4fa1"));
      }).first();
  if (!table.length) {
    throw new Error("Could not find is-checker price table");
  }

  const columns = table.find("thead tr").first().find("th,td").map((index, cell) => {
    const el = $(cell);
    const label = cleanCellText(el.clone().find(".shop-xlinks").remove().end().text());
    const kind = columnKind($, cell, label);
    return {
      index,
      label,
      html: sanitizeTableHtml(el.html() || ""),
      shop: kind.shop,
      store: kind.store,
      teika: el.attr("data-teika") || null,
      className: el.attr("class") || ""
    };
  }).get();

  const rows = table.find("tbody tr").map((rowIndex, row) => {
    const tr = $(row);
    const cells = tr.find("td,th").map((cellIndex, cell) => {
      const el = $(cell);
      const label = cleanCellText(el.text());
      const kind = columnKind($, cell, columns[cellIndex]?.label || label);
      return {
        index: cellIndex,
        text: label,
        html: sanitizeTableHtml(el.html() || ""),
        shop: kind.shop,
        store: kind.store,
        teika: el.attr("data-teika") || null,
        className: el.attr("class") || "",
        isBest: el.hasClass("is-best") || el.hasClass("highest")
      };
    }).get();

    return {
      index: rowIndex,
      kind: tr.attr("data-model") || cleanCellText(cells[0]?.text),
      capacity: tr.attr("data-cap") || tr.attr("data-capacity") || cleanCellText(cells[1]?.text),
      color: tr.attr("data-color-name") || tr.attr("data-color") || cleanCellText(cells[2]?.text),
      teikaOld: Number(tr.attr("data-teika-old")) || parsePriceNumber(cells[3]?.text),
      teikaNew: Number(tr.attr("data-teika-new")) || null,
      isUpdateRow: tr.hasClass("update-row") || cells.some(cell => cell.className.includes("upd-row")),
      cells
    };
  }).get();

  const dataRows = rows.filter(row => !row.isUpdateRow);
  const priceChanges = withSharedPriceChanges(rows);
  const bestProfit = dataRows.reduce((best, row) => {
    const rawProfit = row.cells[4]?.text || "";
    const profitMatch = rawProfit.replace(/,/g, "").match(/[+-]\d+/);
    if (profitMatch) return Math.max(best, Number(profitMatch[0]));

    const retail = parsePriceNumber(row.cells[3]?.text);
    const maxShopPrice = Math.max(
      ...row.cells
        .filter(cell => cell.shop)
        .map(cell => parsePriceNumber(cell.text))
        .filter(price => price != null)
    );
    if (!retail || !Number.isFinite(maxShopPrice)) return best;
    return Math.max(best, maxShopPrice - retail);
  }, -Infinity);

  return {
    ok: true,
    sourceUrl: IS_CHECKER_URL,
    updatedAt: new Date().toISOString(),
    columns,
    rows,
    priceChanges,
    summary: {
      rowCount: dataRows.length,
      shopCount: columns.filter(column => column.shop).length,
      storeCount: columns.filter(column => column.store).length,
      bestProfit: Number.isFinite(bestProfit) ? bestProfit : null
    }
  };
}

app.get("/api/prices", (req, res) => {
  res.json(loadJSON(DATA_FILE, { rows: [], updatedAt: null, errors: [] }));
});

app.get("/api/live-prices", async (req, res) => {
  try {
    res.json(await scrapeLivePrices());
  } catch (error) {
    res.status(500).json({
      ok: false,
      rows: [],
      updatedAt: null,
      errors: [{ error: error?.message || String(error) }]
    });
  }
});

app.get("/api/is-checker", async (req, res) => {
  try {
    const now = Date.now();
    if (!isCheckerCache || now - isCheckerCache.savedAt > IS_CHECKER_CACHE_MS || req.query.refresh === "1") {
      isCheckerCache = { savedAt: now, data: await scrapeIsChecker() };
    }
    res.json(isCheckerCache.data);
  } catch (error) {
    res.status(500).json({
      ok: false,
      sourceUrl: IS_CHECKER_URL,
      updatedAt: null,
      columns: [],
      rows: [],
      summary: { rowCount: 0, shopCount: 0, storeCount: 0, bestProfit: null },
      errors: [{ error: error?.message || String(error) }]
    });
  }
});

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    version: "2026-09-19-vercel-serverless-fix",
    vercel: Boolean(process.env.VERCEL),
    hasLivePrices: true
  });
});

app.get("/api/sources", (req, res) => {
  res.json(loadJSON(SOURCES_FILE, { sources: [] }));
});

app.post("/api/check", async (req, res) => {
  try {
    res.json(await runPriceCheck({ manual: true }));
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

if (!process.env.VERCEL) {
  if (process.env.DISABLE_PRICE_CHECK !== "1") {
    cron.schedule(CHECK_CRON, () => {
      runPriceCheck().catch(err => console.error("Cron check error:", err));
    });

    runPriceCheck().catch(err => console.error("Initial check error:", err));
  }

  app.listen(PORT, () => {
    console.log(`Kaitori bot running: http://localhost:${PORT}`);
    console.log(`Check schedule: ${CHECK_CRON}`);
  });
}

export default app;
