/**
 * Minimal pub/sub. Every module talks through this rather than reaching for
 * each other, so panels can be added or removed without touching their peers.
 *
 * Channels used across the app:
 *   state:change   { key, value, prev }   — store mutation
 *   telemetry      { metrics, history }   — 4 Hz sampler tick
 *   log            { level, tag, text }   — anything worth printing
 *   alert          { level, title, note } — anomaly raised
 *   command        { line }               — user submitted the prompt
 *   speech:*       start | boundary | end — TTS lifecycle
 *   core:pulse     { strength }           — reactor ripple
 */
export class Bus {
  constructor() {
    /** @type {Map<string, Set<Function>>} */
    this.channels = new Map();
  }

  on(channel, handler) {
    if (!this.channels.has(channel)) this.channels.set(channel, new Set());
    this.channels.get(channel).add(handler);
    return () => this.off(channel, handler);
  }

  once(channel, handler) {
    const off = this.on(channel, (payload) => {
      off();
      handler(payload);
    });
    return off;
  }

  off(channel, handler) {
    this.channels.get(channel)?.delete(handler);
  }

  emit(channel, payload) {
    const subscribers = this.channels.get(channel);
    if (!subscribers) return;
    // Copy first: a handler may unsubscribe itself mid-dispatch.
    for (const handler of [...subscribers]) {
      try {
        handler(payload);
      } catch (error) {
        console.error(`[bus] handler failed on "${channel}"`, error);
      }
    }
  }
}

export const bus = new Bus();
