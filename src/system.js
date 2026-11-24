// CPU, memory and disk of the machine Apiary runs on, read from Linux (the same numbers a task manager shows).
import { readFileSync, statfsSync } from 'node:fs';
import os from 'node:os';

let prev = null, cache = null, cacheAt = 0;
function cpuTimes() {
  const line = readFileSync('/proc/stat', 'utf8').split('\n')[0].trim().split(/\s+/).slice(1).map(Number);
  const idle = line[3] + (line[4] || 0), total = line.reduce((a, b) => a + b, 0);
  return { idle, total };
}
export function snapshot(dir = os.homedir()) {
  const now = Date.now();
  if (cache && now - cacheAt < 2000) return cache;   // several open tabs share one reading
  let cpu = null, mem = null, disk = null;
  try { const t = cpuTimes(); if (prev && t.total > prev.total) cpu = Math.max(0, Math.min(100, Math.round(100 * (1 - (t.idle - prev.idle) / (t.total - prev.total))))); prev = t; if (cpu === null) cpu = Math.min(100, Math.round(100 * os.loadavg()[0] / os.cpus().length)); } catch { cpu = Math.min(100, Math.round(100 * os.loadavg()[0] / (os.cpus().length || 1))); }
  try {
    const m = readFileSync('/proc/meminfo', 'utf8'), g = (k) => Number(new RegExp(`^${k}:\\s+(\\d+)`, 'm').exec(m)?.[1] || 0) * 1024;
    const total = g('MemTotal'), avail = g('MemAvailable'); mem = { total, used: total - avail };
  } catch { mem = { total: os.totalmem(), used: os.totalmem() - os.freemem() }; }
  try { const s = statfsSync(dir), total = s.blocks * s.bsize, free = s.bavail * s.bsize; disk = { total, used: total - free }; } catch { disk = null; }
  cache = { cpu, cores: os.cpus().length, load: os.loadavg().map((x) => Math.round(x * 100) / 100), mem, disk, uptime: Math.round(os.uptime()), at: now }; cacheAt = now;
  return cache;
}
