// Model advice: which model suits a role and how hard the work is.
//   heavy  = most capable (hard design, security, legal, money)
//   normal = balanced (everyday engineering, writing, planning)
//   light  = fast and cheap (lookups, summaries, routine checks)
const HEAVY = new Set(['security', 'legal', 'finance']);
const LIGHT = new Set(['operations', 'research']);
const TIER_TEXT = { heavy: 'the most capable model', normal: 'a balanced model', light: 'a fast, low-cost model' };

export const complexityOf = (word) => ({ simple: 'light', easy: 'light', light: 'light', normal: 'normal', medium: 'normal', hard: 'heavy', complex: 'heavy', heavy: 'heavy' }[String(word || '').toLowerCase()] || null);

// Pick a model from the ones available for this AI. `models` is [{id,label}], best known names matched by family.
export function suggestModel({ provider = 'claude', department = '', role = '', complexity = null, models = [] } = {}) {
  let tier = complexityOf(complexity);
  let why;
  if (tier) why = `You said the work is ${complexity}.`;
  else {
    const text = `${role}`.toLowerCase();
    if (HEAVY.has(department) || /architect|audit|threat|compliance|contract|forecast/.test(text)) { tier = 'heavy'; why = `${department ? department[0].toUpperCase() + department.slice(1) : 'This'} work is high-stakes, where a mistake costs a lot.`; }
    else if (LIGHT.has(department) || /summar|lookup|triage|monitor|schedul/.test(text)) { tier = 'light'; why = 'This work is mostly looking things up and routine checks, so speed and cost matter more than depth.'; }
    else { tier = 'normal'; why = 'This is everyday work that a balanced model handles well.'; }
  }
  const family = { heavy: /opus|gpt-\d+(\.\d+)?$|o\d|pro|max/i, light: /haiku|mini|nano|flash/i, normal: /sonnet|codex|gpt/i }[tier];
  const full = models.filter((m) => !/mini|nano|flash|haiku/i.test(m.id));
  const pick = tier === 'normal' && provider !== 'claude' ? full[1] || full[0] || null : models.find((m) => family.test(m.id)) || null;
  const fallback = provider === 'claude' ? { heavy: 'claude-opus-5-5', normal: 'claude-sonnet-5-5', light: 'claude-haiku-5-5' }[tier] : '';
  const model = pick?.id || fallback;
  return { tier, model, why: `${why} Suggested: ${TIER_TEXT[tier]}${model ? ` (${model})` : ''}.` };
}
