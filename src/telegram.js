// Telegram alerts: short messages to your own Telegram bot chat when something needs you.
// Alerts only. A message never contains command output, file contents or secrets: just a short title
// (who, which project, what is waiting). The bot token is kept in the secrets vault. Only the one chat
// you linked is ever answered; anyone else who finds the bot is ignored.
import crypto from 'node:crypto';

const API = () => (process.env.APIARY_TELEGRAM_API || 'https://api.telegram.org').replace(/\/$/, '');
const err = (status, message) => Object.assign(new Error(message), { status });
export const TOKEN_NAME = 'Telegram bot token';
const DEFAULTS = { enabled: false, chatId: '', events: { approvals: true, health: true, tasks: true }, longTaskMinutes: 10 };
const clip = (t, n = 220) => String(t).replace(/\s+/g, ' ').trim().slice(0, n);

export class Telegram {
  constructor(engine) {
    this.engine = engine; this.sent = []; this.recent = new Map(); this.offset = 0; this.linking = null; this.polling = false; this.lastError = ''; this.lastOk = 0; this.workStart = new Map();
    engine.on?.('event', (ev) => this._onEvent(ev));
    engine.on?.('health-new', (i) => this._health(i));
    engine.on?.('task-done', (d) => this._taskDone(d));
  }
  get st() { return (this.engine.store.data.settings.telegram ||= {}); }
  get config() { const c = { ...DEFAULTS, ...this.st, events: { ...DEFAULTS.events, ...(this.st.events || {}) } }; return c; }
  get hasToken() { const v = this.engine.vault; return !!(v.exists && v.list().some((x) => x.name === TOKEN_NAME)); }
  get status() { const c = this.config; return { enabled: c.enabled, linked: !!c.chatId, hasToken: this.hasToken, vaultLocked: this.engine.vault.exists && !this.engine.vault.unlocked, lastError: this.lastError, lastOk: this.lastOk, linking: this.linking ? { code: this.linking.code, until: this.linking.until } : null }; }
  _token() {
    const v = this.engine.vault;
    if (!v.exists || !v.unlocked) return '';
    const it = v.byName(TOKEN_NAME); return it ? v.value(it.id) || '' : '';
  }
  setConfig(b = {}) {
    const c = this.config, st = this.st;
    if (b.token !== undefined && String(b.token).trim()) {
      const t = String(b.token).trim();
      if (!/^\d{5,}:[\w-]{20,}$/.test(t)) throw err(400, 'That does not look like a bot token. It looks like 123456789:ABCdef... and comes from @BotFather.');
      const v = this.engine.vault;
      if (!v.exists) throw err(409, 'Create the secrets vault first (Settings > Secrets vault). The bot token is stored there, encrypted.');
      if (!v.unlocked) throw err(409, 'Unlock the secrets vault first, so the bot token can be saved in it.');
      const it = v.byName(TOKEN_NAME);
      if (it) v.update(it.id, { value: t }); else v.add(TOKEN_NAME, t, 'Telegram bot for Apiary alerts', '', { type: 'token' });
      this.offset = 0;
    }
    if (b.enabled !== undefined) st.enabled = !!b.enabled;
    if (b.events && typeof b.events === 'object') st.events = { ...c.events, ...Object.fromEntries(['approvals', 'health', 'tasks'].filter((k) => k in b.events).map((k) => [k, !!b.events[k]])) };
    if (b.longTaskMinutes !== undefined) { const n = Math.round(Number(b.longTaskMinutes)); if (!(n >= 1 && n <= 600)) throw err(400, 'Long task time must be between 1 and 600 minutes'); st.longTaskMinutes = n; }
    if (st.enabled && !this.hasToken) throw err(400, 'Add the bot token first.');
    this.engine.store.save();
    this.poll();
    return this.status;
  }
  async _call(method, body = {}, timeoutMs = 15000) {
    const token = this._token(); if (!token) throw err(409, this.engine.vault.exists && !this.engine.vault.unlocked ? 'The secrets vault is locked, so the bot token cannot be read.' : 'No bot token saved.');
    const r = await fetch(`${API()}/bot${token}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.ok === false) throw err(502, `Telegram said: ${j.description || 'HTTP ' + r.status}`);
    return j.result;
  }
  // Sends one alert to the linked chat. Deduplicated (10 minutes) and capped (30 an hour).
  async alert(text, { force = false } = {}) {
    const c = this.config;
    if (!force && (!c.enabled || !c.chatId)) return false;
    if (!c.chatId) throw err(409, 'No chat is linked yet.');
    text = clip(this.engine._redact(text), 400);
    const now = Date.now();
    if (!force) {
      if ((this.recent.get(text) || 0) > now - 600000) return false;
      this.sent = this.sent.filter((t) => t > now - 3600000); if (this.sent.length >= 30) return false;
    }
    this.recent.set(text, now); this.sent.push(now);
    for (const [k, t] of this.recent) if (t < now - 600000) this.recent.delete(k);
    try { await this._call('sendMessage', { chat_id: c.chatId, text, disable_web_page_preview: true }); this.lastOk = now; this.lastError = ''; this.engine.audit?.add('system', { actor: 'Apiary', action: 'sent a Telegram alert', detail: clip(text, 120) }); return true; }
    catch (e) { this.lastError = e.message; return false; }
  }
  async test() { await this.alert('✅ Apiary can reach you here. This is a test alert.', { force: true }); if (this.lastError) throw err(502, this.lastError); return { ok: true }; }
  _onEvent(ev) {
    if (ev.type !== 'approval' || ev.approval?.status !== 'pending' || !this.config.events.approvals) return;
    const a = ev.approval, p = this.engine.agents[a.agentId];
    this.alert(`🔔 Approval waiting${p ? ` (${this.engine._pname(p) || 'CEO'})` : ''}: ${a.title}`);
  }
  _health(i) { if (this.config.events.health && (i.level === 'warn' || i.level === 'err')) this.alert(`${i.level === 'err' ? '🔴' : '🟠'} Health: ${i.title}. Open Apiary > Health for what to do.`); }
  _taskDone({ agent, ms, failed }) {
    const c = this.config; if (!c.events.tasks || ms < c.longTaskMinutes * 60000) return;
    this.alert(`${failed ? '⚠️ Stopped with an error' : '✅ Finished'}: ${agent.name}${this.engine._pname(agent) ? ` (${this.engine._pname(agent)})` : ''} after ${Math.round(ms / 60000)} min.`);
  }
  // Linking: you send a short code to the bot from your own chat. Nothing is accepted before that.
  startLink() {
    if (!this.hasToken) throw err(400, 'Add the bot token first.');
    this.linking = { code: String(crypto.randomInt(100000, 1000000)), until: Date.now() + 10 * 60000 };
    this.poll(); return this.status;
  }
  unlink() { this.st.chatId = ''; this.linking = null; this.engine.store.save(); return this.status; }
  // Long polling, only while enabled or linking. Replies only to the linked chat.
  async poll() {
    if (this.polling) return; const want = () => (this.config.enabled || this.linking) && this._token();
    if (!want()) return;
    this.polling = true;
    try {
      while (want()) {
        if (this.linking && Date.now() > this.linking.until) this.linking = null;
        let ups;
        try { ups = await this._call('getUpdates', { offset: this.offset, timeout: process.env.APIARY_TELEGRAM_API ? 1 : 25, allowed_updates: ['message'] }, 35000); this.lastError = ''; }
        catch (e) { this.lastError = e.message; await new Promise((r) => setTimeout(r, 15000)); continue; }
        for (const u of ups || []) { this.offset = u.update_id + 1; await this._message(u.message).catch(() => {}); }
        if (process.env.APIARY_TELEGRAM_API) await new Promise((r) => setTimeout(r, 150));
      }
    } finally { this.polling = false; }
  }
  async _message(m) {
    if (!m || !m.chat || m.chat.type !== 'private') return;
    const chat = String(m.chat.id), text = String(m.text || '').trim(), c = this.config;
    if (c.chatId) {
      if (chat !== String(c.chatId)) return;   // a stranger: no answer at all
      if (/^\/status\b/i.test(text)) {
        const e = this.engine, pend = e.approvals().filter((a) => a.status === 'pending').length, work = Object.values(e.agents).filter((a) => a.status === 'working').length;
        await this._call('sendMessage', { chat_id: chat, text: `Apiary: ${work} working, ${pend} approval${pend === 1 ? '' : 's'} waiting, ${e.health.count} health warning${e.health.count === 1 ? '' : 's'}.` });
      }
      return;
    }
    if (this.linking && text === this.linking.code) {
      this.st.chatId = chat; this.linking = null; this.engine.store.save();
      this.engine.audit?.add('system', { actor: 'You', action: 'linked a Telegram chat' });
      await this._call('sendMessage', { chat_id: chat, text: '✅ Linked. Apiary will send alerts to this chat. Send /status any time.' });
      this.engine.emit('event', { type: 'telegram' });
    }
  }
}
