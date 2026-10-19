const config = window.MANAGER_CONFIG || {};
const supabase = config.url && config.anon ? window.supabase.createClient(config.url, config.anon) : null;
const api = async (path, options = {}) => {
  const { data: { session } } = supabase ? await supabase.auth.getSession() : { data: { session: null } };
  const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
  if (session?.access_token) headers.Authorization = `Bearer ${session.access_token}`;
  const response = await fetch(path, { ...options, headers });
  if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || `HTTP ${response.status}`);
  return response.status === 204 ? null : response.json();
};
async function loadTasks() {
  const result = await api("/api/manager/tasks");
  const rows = document.querySelector("tbody");
  if (!rows) return;
  rows.innerHTML = result.tasks.map(task => `<tr data-id="${task.id}"><td>${task.products?.name || task.product_id}</td><td>${task.products?.sku || "—"}</td><td>${task.max_price == null ? "—" : `¥${task.max_price.toLocaleString()}`}</td><td><span class="pill ${task.status === "failed" ? "red" : task.status === "completed" ? "green" : "amber"}">${task.status}</span><div class="meta">${task.error_message || task.last_event || ""}</div></td><td><button class="btn" data-action="start">Start</button> <button class="btn" data-action="pause">Pause</button> <button class="btn" data-action="delete">Delete</button></td></tr>`).join("") || `<tr><td colspan="5" class="empty">No tasks</td></tr>`;
  rows.querySelectorAll("button[data-action]").forEach(button => button.addEventListener("click", async () => { const row = button.closest("tr"); const action = button.dataset.action; if (action === "delete" && !confirm("Delete this task?")) return; await api(`/api/manager/tasks/${row.dataset.id}`, action === "delete" ? { method: "DELETE" } : { method: "PATCH", body: JSON.stringify({ status: action === "start" ? "queued" : "paused" }) }); await loadTasks(); }));
}
async function initManager() { if (!supabase) { document.body.insertAdjacentHTML("afterbegin", `<div class="card" style="padding:16px;margin:16px;color:#ff7b88">Supabase Auth is not configured.</div>`); return; } const { data: { session } } = await supabase.auth.getSession(); if (!session) { const email = prompt("Email"); const password = prompt("Password"); if (!email || !password) return; const result = await supabase.auth.signInWithPassword({ email, password }); if (result.error) { alert(result.error.message); return; } } await loadTasks(); supabase.auth.onAuthStateChange(() => loadTasks().catch(console.error)); }
initManager().catch(error => { console.error(error); alert(error.message); });
