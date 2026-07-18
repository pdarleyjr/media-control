const pending = [];
const local = new Map();
const MAX_LOCAL_PER_METRIC = 200;
let flushTimer = null;

function surface() {
  return window.location.pathname.startsWith('/console/') ? 'podium' : 'web';
}

function record(name, durationMs, extra = {}) {
  const duration = Number(durationMs);
  if (!Number.isFinite(duration) || duration < 0 || duration > 120000) return;
  const sample = { name, duration_ms: duration, surface: surface(), ...extra };
  pending.push(sample);
  const values = local.get(name) || [];
  values.push(duration);
  if (values.length > MAX_LOCAL_PER_METRIC) values.shift();
  local.set(name, values);
  scheduleFlush();
}

function start(name, extra = {}) {
  const started = performance.now();
  return () => record(name, performance.now() - started, extra);
}

function scheduleFlush() {
  if (flushTimer || pending.length === 0) return;
  flushTimer = setTimeout(flush, pending.length >= 20 ? 250 : 10000);
}

async function flush() {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = null;
  if (!pending.length) return;
  const entries = pending.splice(0, 50);
  const token = localStorage.getItem('token');
  if (!token) return;
  try {
    const response = await fetch('/api/status/performance', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ entries }),
      keepalive: true,
    });
    if (!response.ok) throw new Error('runtime samples rejected');
  } catch {
    pending.unshift(...entries.slice(-50));
  }
  if (pending.length) scheduleFlush();
}

function summary() {
  return [...local.entries()].map(([name, source]) => {
    const values = [...source].sort((a, b) => a - b);
    const at = (q) => values[Math.min(values.length - 1, Math.max(0, Math.ceil(q * values.length) - 1))] || 0;
    return { name, count: values.length, p50_ms: at(0.5), p95_ms: at(0.95), max_ms: values.at(-1) || 0 };
  });
}

function observeLongTasks() {
  if (!window.PerformanceObserver || !PerformanceObserver.supportedEntryTypes?.includes('longtask')) return;
  try {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) record('ui.long_task', entry.duration);
    });
    observer.observe({ type: 'longtask', buffered: true });
  } catch { /* unsupported browser */ }
}

observeLongTasks();
window.addEventListener('pagehide', flush);

export const performanceMetrics = { record, start, flush, summary };
window.mcPerformance = performanceMetrics;
