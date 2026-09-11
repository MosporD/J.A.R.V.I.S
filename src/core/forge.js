import { bus } from './bus.js';
import { register, respond, log } from './commands.js';

/**
 * The link to the content foundry.
 *
 * `forge/` is a separate service on its own port, so unlike every other signal
 * on this dashboard it can simply be absent — the workshop runs whether or not
 * the pipeline is up. The sampler treats that as a normal state rather than a
 * fault: it backs off when nothing answers, reports N/D the way the diagnostics
 * panel does, and never blocks a frame waiting for a reply.
 *
 * Channels:
 *   forge        { online, health, pipeline }   — every successful poll
 *   forge:link   { online, endpoint, error }    — transitions only
 */

const ENDPOINT = (import.meta.env?.VITE_FORGE_API || 'http://localhost:8000').replace(/\/$/, '');

const POLL_MS = 10000;
const TIMEOUT_MS = 4000;
// Doubles on each failure. A pipeline that is simply not running should cost
// one request every couple of minutes, not one every ten seconds forever.
const MAX_BACKOFF_MS = 120000;

async function getJSON(path, signal) {
  const response = await fetch(`${ENDPOINT}${path}`, { signal, headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.json();
}

class Forge {
  constructor() {
    this.online = false;
    this.endpoint = ENDPOINT;
    this.health = null;
    this.pipeline = null;
    this.lastError = '';
    this.lastSeen = 0;
    this.timer = null;
    this.backoff = POLL_MS;
  }

  start() {
    if (this.timer) return this;
    this.poll();
    return this;
  }

  stop() {
    clearTimeout(this.timer);
    this.timer = null;
  }

  schedule(delay) {
    clearTimeout(this.timer);
    // Hidden tabs should not keep a request in flight; the next poll happens
    // when the page comes back rather than piling up while it is away.
    this.timer = setTimeout(() => {
      if (document.hidden) return this.schedule(delay);
      this.poll();
    }, delay);
  }

  async poll() {
    const controller = new AbortController();
    const cutoff = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      const [health, pipeline] = await Promise.all([
        getJSON('/health', controller.signal),
        getJSON('/pipeline', controller.signal),
      ]);

      this.health = health;
      this.pipeline = pipeline;
      this.lastSeen = Date.now();
      this.lastError = '';
      this.backoff = POLL_MS;
      this.setOnline(true);
      bus.emit('forge', { online: true, health, pipeline });
    } catch (error) {
      // A pipeline that is not running is the common case, not an incident.
      this.lastError = error.name === 'AbortError' ? 'timed out' : error.message;
      this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS);
      this.setOnline(false);
      bus.emit('forge', { online: false, health: null, pipeline: null });
    } finally {
      clearTimeout(cutoff);
      this.schedule(this.backoff);
    }
  }

  /** Announce only transitions — a link that stays down must not fill the log. */
  setOnline(next) {
    if (next === this.online) return;
    this.online = next;
    bus.emit('forge:link', { online: next, endpoint: this.endpoint, error: this.lastError });
    bus.emit('log', {
      level: next ? 'ok' : 'warn',
      tag: 'forge',
      text: next
        ? `Foundry uplink established — ${this.endpoint}.`
        : `Foundry uplink severed (${this.lastError || 'no response'}).`,
    });
  }

  /** Depth of approved, rendered content waiting to go out. */
  get buffer() {
    return this.health?.pipeline?.buffer ?? null;
  }

  get failures() {
    return this.pipeline?.failures?.length ?? 0;
  }

  /** How many capability slots run on your own hardware, e.g. "7/8". */
  get selfHosted() {
    return this.health?.providers?.self_hosted ?? null;
  }

  counts(stage) {
    return this.health?.pipeline?.[stage] ?? {};
  }
}

export const forge = new Forge();

register({
  name: 'forge',
  aliases: ['foundry', 'pipeline'],
  summary: 'Report content pipeline status.',
  run() {
    if (!forge.online) {
      log(`No response from ${forge.endpoint} — ${forge.lastError || 'link down'}.`, 'warn', 'forge');
      return respond('The foundry is offline, sir. Nothing is being produced.');
    }

    const variants = forge.counts('variants');
    log('— FOUNDRY REPORT ————————————————', 'ok', 'forge');
    log(`  ${'BUFFER'.padEnd(14)} ${forge.buffer} cuts ready or queued`, 'sys', 'forge');
    log(`  ${'SELF-HOSTED'.padEnd(14)} ${forge.selfHosted} slots`, 'sys', 'forge');
    log(`  ${'DATABASE'.padEnd(14)} ${(forge.health.database || 'unknown').toUpperCase()}`, 'sys', 'forge');
    for (const [status, count] of Object.entries(variants)) {
      log(`  ${status.toUpperCase().padEnd(14)} ${count}`, 'sys', 'forge');
    }
    if (forge.failures) {
      log(`  ${'FAILED'.padEnd(14)} ${forge.failures} needing attention`, 'alert', 'forge');
    }

    // The buffer is the figure that predicts whether posting actually stops.
    if (forge.buffer === null) return respond('The foundry is up, sir.');
    if (forge.buffer < 7) {
      return respond(
        `Buffer is thin, sir — ${forge.buffer} cuts ahead of schedule. I would approve more.`,
      );
    }
    return respond(`Foundry nominal, sir. ${forge.buffer} cuts buffered.`);
  },
});
