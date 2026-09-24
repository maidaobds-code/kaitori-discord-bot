const IS_CHECKER_CACHE_KEY = "is_checker_payload_v1";
const IS_CHECKER_CACHE_MS = 30000;

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, c => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "'": "&#39;",
    "\"": "&quot;"
  })[c]);
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
  if (value === "×") return "no-stock";
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
