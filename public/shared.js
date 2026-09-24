const IS_CHECKER_CACHE_KEY = "is_checker_payload_v1";
const IS_CHECKER_CACHE_MS = 30000;
const VI_LABELS = {
  "\u7a2e\u5225": "Loai",
  "\u5bb9\u91cf": "Dung luong",
  "\u8272": "Mau",
  "\u5b9a\u4fa1": "Gia niem yet",
  "\u5dee\u76ca": "Lai/Lo",
  "\u30d0\u30fc\u30ac\u30f3\u30c7\u30a3": "Do Burgundy",
  "\u30b0\u30ec\u30a4\u30b7\u30e3\u30fc": "Xanh Glacier",
  "\u30b7\u30eb\u30d0\u30fc": "Bac",
  "\u30d6\u30e9\u30c3\u30af": "Den",
  "\u30b9\u30bf\u30fc\u30db\u30ef\u30a4\u30c8": "Trang Star",
  "\u30ca\u30a4\u30c8\u30b9\u30ab\u30a4": "Xanh Night Sky",
  "\u7d2b": "Tim",
  "\u9ed2": "Den",
  "\u9752": "Xanh",
  "\u9280": "Bac",
  "\u767d": "Trang",
  "\u68ee\u68ee": "Morimori",
  "\u30bd\u30e0\u30ea\u30a8": "Somurie",
  "\u30a8\u30ce\u30ad\u30f3": "Enoking",
  "\u30a2\u30ad\u30e2\u30d0": "Akimoba",
  "\u7a7a\u9593": "Kukan",
  "\u30e2\u30d0\u30b9\u30c6": "Mobaste",
  "\u30db\u30e0\u30e9": "Homura",
  "\u30eb\u30c7\u30e4": "Rudeya",
  "\u6d77\u5ce1": "Kaikyo",
  "\u5546\u5e97": "Shouten",
  "\u4e00\u4e01\u76ee": "1-Chome",
  "\u697d\u5712": "Rakuen",
  "\u9280\u5ea7": "Ginza",
  "\u4e38\u306e\u5185": "Marunouchi",
  "\u8868\u53c2\u9053": "Omotesando",
  "\u65b0\u5bbf": "Shinjuku",
  "\u6e0b\u8c37": "Shibuya",
  "\u5ddd\u5d0e": "Kawasaki",
  "\u6885\u7530": "Umeda",
  "\u5fc3\u658e\u6a4b": "Shinsaibashi",
  "\u4eac\u90fd": "Kyoto",
  "\u540d\u53e4\u5c4b": "Nagoya",
  "\u798f\u5ca1": "Fukuoka"
};

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, c => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "'": "&#39;",
    "\"": "&quot;"
  })[c]);
}

function translateVi(value) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  if (text.includes("\u5dee\u76ca")) return "Lai/Lo";
  return VI_LABELS[text] || text;
}

function displayColumnLabel(column) {
  if (column.shop) return translateVi(column.label || column.shop);
  if (column.store) return translateVi(column.label || column.store);
  return translateVi(column.label);
}

function checkedSet(rootId) {
  return new Set([...document.querySelectorAll(`#${rootId} input[type="checkbox"]:checked`)].map(input => input.value));
}

function parseNumber(value) {
  const match = String(value ?? "").replace(/,/g, "").match(/\d{4,9}/);
  return match ? Number(match[0]) : null;
}

function stockClass(text) {
  const value = String(text || "").trim();
  if (!value || value === "-") return "unknown";
  if (value === "\u00d7") return "no-stock";
  return "has-stock";
}

function stockText(text) {
  const value = String(text || "").trim();
  return value || "-";
}

async function fetchIsChecker({ force = false } = {}) {
  if (!force) {
    try {
      const cached = JSON.parse(sessionStorage.getItem(IS_CHECKER_CACHE_KEY) || "null");
      if (cached && Date.now() - cached.savedAt < IS_CHECKER_CACHE_MS) {
        return cached.data;
      }
    } catch {}
  }

  const refresh = force ? "&refresh=1" : "";
  const res = await fetch(`/api/is-checker?_=${Date.now()}${refresh}`, { cache: "no-store" });
  const data = await res.json();
  if (!res.ok || !data.ok) throw new Error(data.errors?.[0]?.error || `API returned ${res.status}`);

  try {
    sessionStorage.setItem(IS_CHECKER_CACHE_KEY, JSON.stringify({ savedAt: Date.now(), data }));
  } catch {}

  return data;
}
