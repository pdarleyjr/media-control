// MBFD Media Control Studio — AI service (server-side ONLY).
// Talks to the local Ollama (config.ollamaBaseUrl, default the Docker bridge
// gateway) using the native /api/chat JSON mode. The frontend NEVER calls
// Ollama; it calls our API, which calls this. qwen3.6:35b is a reasoning model,
// so we pass think:false to suppress chain-of-thought from polluting the JSON.
//
// Output is the canonical mbfd-deck-v1 deck with a SIMPLE, player-renderable
// slide shape (title/subtitle/bullets/body/speaker_notes/duration). A
// validate-and-repair loop re-prompts once on bad/invalid JSON before failing.

const config = require('../config');

const DECK_SYSTEM = [
  'You are an expert instructional designer for the Miami Beach Fire Department training division.',
  'Produce a slide deck as STRICT JSON ONLY — no markdown fences, no commentary, no prose outside the JSON.',
  'Schema (mbfd-deck-v1):',
  '{"version":"mbfd-deck-v1","title":<string>,"theme":"mbfd-command","canvas_profile":"16x9",',
  '"slides":[{"layout":"title"|"section"|"content"|"quote","title":<string>,"subtitle":<string optional>,',
  '"bullets":[<string>] (optional),"body":<string optional>,"speaker_notes":<string>,"duration_seconds":<number>}]}',
  'Rules: first slide layout="title". 6-12 slides. Bullets concise (<= ~12 words each, <= 6 per slide).',
  'Every slide MUST have content (a title plus bullets or body). speaker_notes = 1-3 instructor-facing sentences.',
  'Content must be accurate, safety-focused, and appropriate for professional firefighters.',
].join('\n');

async function ollamaChat(messages, { format, temperature = 0.5, timeoutMs = 180000 } = {}) {
  const body = {
    model: config.ollamaModel,
    messages,
    stream: false,
    think: false,
    options: { temperature, num_ctx: 16384 },
  };
  if (format) body.format = format;
  const res = await fetch(`${config.ollamaBaseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Ollama ${res.status}: ${t.slice(0, 200)}`);
  }
  const data = await res.json();
  return (data.message && data.message.content) || '';
}

function asArray(v) {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string' && v.trim()) return v.split(/\r?\n|•|^[-*]\s/m).map((s) => s.replace(/^[-*]\s*/, '').trim()).filter(Boolean);
  return [];
}

const LAYOUTS = ['title', 'section', 'content', 'quote'];

function normalizeDeck(obj, fallbackTitle, canvas) {
  const slidesIn = Array.isArray(obj?.slides) ? obj.slides : (Array.isArray(obj) ? obj : []);
  const slides = slidesIn.map((s, i) => {
    const layout = LAYOUTS.includes(s.layout) ? s.layout : (i === 0 ? 'title' : 'content');
    const bullets = asArray(s.bullets || s.points || s.items).map((b) => String(b).slice(0, 300)).slice(0, 8);
    return {
      id: 'slide_' + String(i + 1).padStart(3, '0'),
      layout,
      title: String(s.title || s.heading || '').slice(0, 200),
      subtitle: s.subtitle ? String(s.subtitle).slice(0, 300) : undefined,
      bullets,
      body: s.body ? String(s.body).slice(0, 1200) : undefined,
      speaker_notes: String(s.speaker_notes || s.notes || '').slice(0, 2000),
      duration_seconds: Number(s.duration_seconds) > 0 ? Number(s.duration_seconds) : 12,
    };
  });
  return {
    version: 'mbfd-deck-v1',
    title: String(obj?.title || fallbackTitle || 'Untitled Presentation').slice(0, 200),
    theme: 'mbfd-command',
    canvas_profile: canvas || '16x9',
    slides,
    assets: [],
  };
}

function validateDeck(d) {
  if (!d || !Array.isArray(d.slides) || d.slides.length === 0) return 'deck has no slides';
  const empty = d.slides.findIndex((s) => !s.title && !(s.bullets && s.bullets.length) && !s.body);
  if (empty >= 0) return `slide ${empty + 1} has no content`;
  return null;
}

// Generate a full deck from a prompt. Returns a validated mbfd-deck-v1 object.
async function generateDeck({ prompt, title, audience, slideCount = 8, canvasProfile = '16x9' }) {
  if (!prompt || !String(prompt).trim()) throw new Error('prompt required');
  let user = `Topic / request: ${String(prompt).trim()}\nTarget slide count: ${slideCount}.`;
  if (audience) user += `\nAudience: ${audience}.`;
  if (title) user += `\nUse this deck title: ${title}.`;
  const messages = [{ role: 'system', content: DECK_SYSTEM }, { role: 'user', content: user }];

  let lastErr = 'unknown error';
  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = await ollamaChat(messages, { format: 'json', temperature: attempt === 0 ? 0.5 : 0.2 });
    let parsed;
    try { parsed = JSON.parse(raw); }
    catch {
      lastErr = 'model returned non-JSON';
      messages.push({ role: 'assistant', content: raw.slice(0, 400) });
      messages.push({ role: 'user', content: 'That was not valid JSON. Output ONLY the JSON object for mbfd-deck-v1, nothing else.' });
      continue;
    }
    const deck = normalizeDeck(parsed, title || prompt, canvasProfile);
    const err = validateDeck(deck);
    if (!err) return deck;
    lastErr = err;
    messages.push({ role: 'assistant', content: JSON.stringify(parsed).slice(0, 400) });
    messages.push({ role: 'user', content: `The deck was invalid: ${err}. Return ONLY corrected mbfd-deck-v1 JSON with every slide populated.` });
  }
  throw new Error('AI deck generation failed: ' + lastErr);
}

// Health probe used by the route to fail fast with a useful message.
async function ping() {
  const res = await fetch(`${config.ollamaBaseUrl}/api/tags`, { signal: AbortSignal.timeout(4000) });
  if (!res.ok) throw new Error('Ollama not reachable');
  const d = await res.json();
  return { ok: true, models: (d.models || []).map((m) => m.name) };
}

module.exports = { generateDeck, ollamaChat, normalizeDeck, validateDeck, ping };
