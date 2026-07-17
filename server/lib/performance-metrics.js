'use strict';

const MAX_SAMPLES = 1000;
const samples = [];

function normalizeEntries(entries, context = {}) {
  if (!Array.isArray(entries)) return [];
  return entries.slice(0, 50).flatMap((entry) => {
    const name = String(entry?.name || '');
    const duration = Number(entry?.duration_ms);
    if (!/^[a-z0-9_.:-]{1,80}$/i.test(name) || !Number.isFinite(duration) || duration < 0 || duration > 120000) return [];
    return [{
      name,
      duration_ms: Math.round(duration * 100) / 100,
      surface: String(entry?.surface || context.surface || 'web').slice(0, 32),
      user_id: context.user_id || null,
      recorded_at: Date.now(),
    }];
  });
}

function record(entries, context) {
  const accepted = normalizeEntries(entries, context);
  samples.push(...accepted);
  if (samples.length > MAX_SAMPLES) samples.splice(0, samples.length - MAX_SAMPLES);
  return accepted.length;
}

function percentile(sorted, value) {
  if (!sorted.length) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(value * sorted.length) - 1));
  return sorted[index];
}

function summarize() {
  const groups = new Map();
  for (const sample of samples) {
    const key = `${sample.surface}:${sample.name}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(sample.duration_ms);
  }
  return [...groups.entries()].map(([key, values]) => {
    values.sort((a, b) => a - b);
    const separator = key.indexOf(':');
    return {
      surface: key.slice(0, separator),
      name: key.slice(separator + 1),
      count: values.length,
      p50_ms: percentile(values, 0.50),
      p95_ms: percentile(values, 0.95),
      max_ms: values[values.length - 1],
    };
  }).sort((a, b) => a.surface.localeCompare(b.surface) || a.name.localeCompare(b.name));
}

function reset() { samples.length = 0; }

module.exports = { MAX_SAMPLES, normalizeEntries, record, summarize, reset };
