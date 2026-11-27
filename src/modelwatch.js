// Notices when an agent's model is too weak for its work (it keeps failing or being sent back), or stronger than it needs (a long run of
// smooth work on the most capable model). Pure rules; the engine decides what to do with the answer.
export const RANK = { light: 0, normal: 1, heavy: 2 };
export const WINDOW = 12;           // how many recent outcomes are remembered per agent
export const UP_BAD = 3;            // this many bad outcomes among the last 6 means "needs a stronger model"
export const DOWN_OK = 10;          // this many good outcomes in a row on a strong model means "could use a cheaper one"
export const COOL_MS = 24 * 3600e3; // after a nudge, wait a day before the next one for the same agent
export const DECLINED_MS = 7 * 24 * 3600e3;

// What kind of model is this? (light = fast and cheap, normal = balanced, heavy = most capable). Unknown names return null.
export function tierOfModel(id) {
  const m = String(id || '').toLowerCase();
  if (!m) return null;
  if (/haiku|mini|nano|flash/.test(m)) return 'light';
  if (/opus|fable|mythos|\bpro\b|max|(^|[-_])o\d|gpt-\d+(\.\d+)?$/.test(m)) return 'heavy';
  if (/sonnet|codex|gpt/.test(m)) return 'normal';
  return null;
}

// The model of a tier among the ones available for this AI.
export function modelForTier(tier, provider, models = []) {
  const ids = models.map((x) => x.id);
  const by = (re) => ids.find((id) => re.test(id));
  if (tier === 'heavy') return by(/opus|fable|mythos/i) || by(/gpt-\d+(\.\d+)?$/i) || by(/\bpro\b|max|(^|[-_])o\d/i) || (provider === 'claude' ? 'claude-opus-5-5' : '');
  if (tier === 'light') return by(/haiku|mini|nano|flash/i) || (provider === 'claude' ? 'claude-haiku-5-5' : '');
  return by(/sonnet/i) || ids.filter((id) => tierOfModel(id) === 'normal')[0] || (provider === 'claude' ? 'claude-sonnet-5-5' : '');
}

// runs: a string of outcomes, oldest first: "o" went well, "b" went badly.
export function judge({ runs = '', model = '', roleTier = 'normal', now = Date.now(), coolUntil = 0 }) {
  if (now < coolUntil) return null;
  const tier = tierOfModel(model) || 'normal';   // no model chosen means the AI's own default, treated as balanced
  const lastSix = runs.slice(-6);
  if ((lastSix.match(/b/g) || []).length >= UP_BAD && tier !== 'heavy') return { direction: 'up', from: tier, to: tier === 'light' ? 'normal' : 'heavy' };
  if (tier === 'heavy' && (lastSix.match(/b/g) || []).length >= UP_BAD) return { direction: 'other-ai' };
  if (model && RANK[tier] > RANK[roleTier] && runs.length >= DOWN_OK && runs.slice(-DOWN_OK) === 'o'.repeat(DOWN_OK)) return { direction: 'down', from: tier, to: roleTier };
  return null;
}
