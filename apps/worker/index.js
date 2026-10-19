import { listTasks, updateTask, heartbeat } from "../../lib/task-store.js";

const workerId = process.env.WORKER_ID || `worker-${process.pid}`;
const ownerId = process.env.WORKER_OWNER_ID || "local-dev";
const intervalMs = Number(process.env.WORKER_INTERVAL_MS || 15000);
let stopping = false;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function tick() { await heartbeat(workerId, "online", ownerId); const tasks = await listTasks(ownerId); for (const task of tasks.filter(item => item.status === "queued")) { try { const claimed = await updateTask(task.id, ownerId, { status: "running", start_time: task.start_time || new Date().toISOString(), last_event: "Worker claimed task" }); if (!claimed || claimed.status !== "running") continue; } catch (error) { await updateTask(task.id, ownerId, { status: "failed", error_message: error.message }); } } }
async function main() { process.on("SIGINT", () => { stopping = true; }); process.on("SIGTERM", () => { stopping = true; }); while (!stopping) { try { await tick(); } catch (error) { console.error(JSON.stringify({ workerId, event: "worker_error", message: error.message })); await heartbeat(workerId, "error"); } await sleep(intervalMs); } await heartbeat(workerId, "offline"); }
main().catch(error => { console.error(error); process.exitCode = 1; });
