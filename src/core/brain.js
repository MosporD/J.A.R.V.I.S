import { bus } from './bus.js';
import { store, MODE } from './store.js';
import { telemetry } from './telemetry.js';
import { ENDPOINT } from './forge.js';
import {
  catalogue, execute, register, setFallback, log, respond,
} from './commands.js';

/**
 * The assistant behind the prompt.
 *
 * Until now an unrecognised line got a canned "that is outside my directive
 * set". This sends it to a model instead, with the directive registry handed
 * over as tools — so "how are we looking?" reaches the status directive, and a
 * question that is not a directive at all gets an answer.
 *
 * The model runs behind forge, never in this page. The dashboard holds the
 * transcript and runs the tools, because the directives act on the dashboard:
 * they redraw panels, clear the log, re-hue the interface. forge is a pure
 * turn — transcript in, a reply or a tool call out.
 *
 * That split is also what keeps a credential out of the browser. With forge's
 * default provider the model is local and nothing leaves the machine at all,
 * which is the point: the speech path streams audio to Google, and this does
 * not have to.
 */

/** How many times the model may call tools before we insist on an answer. */
const MAX_ROUNDS = 4;

/** Turns kept in the transcript. Old context costs tokens and confuses a small model. */
const MAX_HISTORY = 16;

const TIMEOUT_MS = 60000;

/**
 * The registry, described for a model.
 *
 * Every directive takes one optional string, because that is what the prompt
 * itself passes — `execute()` tokenises a line. Giving each directive a bespoke
 * schema would be a second definition of the same verbs, and the two would
 * drift the first time someone added an argument.
 */
export function toolsFromRegistry() {
  return catalogue().map((command) => ({
    name: command.name,
    description: command.summary,
    parameters: {
      type: 'object',
      properties: {
        arguments: {
          type: 'string',
          description:
            'Arguments for the directive, exactly as they would be typed after it. '
            + 'Empty string when it takes none.',
        },
      },
      required: [],
    },
  }));
}

/** What the dashboard currently knows, folded small enough to send every turn. */
function snapshot() {
  const state = store.get();
  const readings = {};
  for (const [key, reading] of Object.entries(telemetry.snapshot() || {})) {
    readings[key] = `${reading.value.toFixed(1)}${reading.unit || ''}`;
  }
  return {
    mode: state.mode,
    threat: state.threat,
    reactor: state.reactor,
    online: state.online,
    telemetry: readings,
  };
}

/**
 * Run a directive and capture what it said.
 *
 * Directives report by emitting on the log channel rather than returning, so
 * the only way to tell the model what happened is to listen while it runs.
 */
async function runDirective(name, argumentString) {
  const lines = [];
  const stop = bus.on('log', ({ tag, text }) => lines.push(`[${tag}] ${text}`));
  try {
    await execute(`${name} ${argumentString || ''}`.trim());
  } finally {
    stop();
  }
  // Drop the echo of the directive itself; the model knows what it asked for.
  const output = lines.filter((line) => !line.startsWith('[you]')).join('\n');
  return output || `${name} completed with no output.`;
}

export class Brain {
  constructor() {
    this.history = [];
    this.ready = false;
    this.provider = '';
    this.model = '';
    this.busy = false;
  }

  /** Ask forge whether a model is reachable, without spending a turn. */
  async probe() {
    try {
      const response = await fetch(`${ENDPOINT}/brain`, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(4000),
      });
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      const status = await response.json();
      this.ready = Boolean(status.ready);
      this.provider = status.provider || '';
      this.model = status.model || '';
      this.local = Boolean(status.local);
      store.set({ brain: this.ready, brainModel: this.model });
      return this.ready;
    } catch {
      this.ready = false;
      store.set({ brain: false, brainModel: '' });
      return false;
    }
  }

  async turn(messages) {
    const response = await fetch(`${ENDPOINT}/brain`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ messages, tools: toolsFromRegistry(), context: snapshot() }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (response.status === 503) {
      const detail = await response.json().catch(() => ({}));
      throw new Error(detail.detail || 'the model is unreachable');
    }
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return response.json();
  }

  /**
   * Put a question to the assistant, running whatever directives it asks for.
   *
   * Returns the spoken reply, or null when there is no assistant to ask.
   */
  async ask(question) {
    if (this.busy) {
      log('Still thinking about the last one, sir.', 'sys', 'brain');
      return null;
    }
    if (!this.ready && !(await this.probe())) return null;

    this.busy = true;
    store.set('mode', MODE.PROCESSING);
    this.history.push({ role: 'user', content: question });
    this.history = this.history.slice(-MAX_HISTORY);

    try {
      for (let round = 0; round < MAX_ROUNDS; round += 1) {
        const result = await this.turn(this.history);
        const calls = result.tool_calls || [];

        if (!calls.length) {
          const reply = result.reply || 'I have nothing to add, sir.';
          this.history.push({ role: 'assistant', content: reply });
          await respond(reply);
          return reply;
        }

        // Record the request before the results, or the transcript describes
        // answers to questions that were never asked.
        this.history.push({
          role: 'assistant',
          content: result.reply || null,
          tool_calls: calls.map((call) => ({
            id: call.id,
            type: 'function',
            function: { name: call.name, arguments: JSON.stringify(call.arguments || {}) },
          })),
        });

        for (const call of calls) {
          const known = catalogue().some((command) => command.name === call.name);
          let output;
          if (call._error) {
            output = `Your arguments were not valid JSON. Try again: ${call._error}`;
          } else if (!known) {
            output = `There is no directive called "${call.name}". Use one from your tool list.`;
          } else {
            output = await runDirective(call.name, call.arguments?.arguments);
            // `execute()` returns the core to idle when a directive finishes.
            // The assistant is still working, so say so again.
            store.set('mode', MODE.PROCESSING);
          }
          this.history.push({
            role: 'tool',
            tool_call_id: call.id,
            name: call.name,
            content: String(output).slice(0, 2000),
          });
        }
      }

      // Out of rounds. Say so rather than looping until the operator gives up.
      const stalled = 'I ran what I could, sir, but I could not settle on an answer.';
      this.history.push({ role: 'assistant', content: stalled });
      await respond(stalled);
      return stalled;
    } catch (error) {
      this.ready = false;
      store.set('brain', false);
      log(`Assistant unreachable — ${error.message}`, 'warn', 'brain');
      return null;
    } finally {
      this.busy = false;
      if (store.get('mode') === MODE.PROCESSING) store.set('mode', MODE.IDLE);
    }
  }

  forget() {
    this.history = [];
  }
}

export const brain = new Brain();

/**
 * Take over the prompt's "I don't know that" path.
 *
 * Registered as a fallback rather than wired into `commands.js` directly: the
 * command layer should not have to know an assistant exists, and this module
 * needs the registry, so importing the other way round would be a cycle.
 */
setFallback(async (line) => {
  const reply = await brain.ask(line);
  return reply !== null;
});

register({
  name: 'brain',
  aliases: ['assistant'],
  summary: 'The assistant behind the prompt (status | forget).',
  async run(args = []) {
    const want = String(args[0] || '').toLowerCase();
    if (want === 'forget') {
      brain.forget();
      return respond('Conversation cleared, sir.');
    }
    const ready = await brain.probe();
    if (!ready) {
      log('No model reachable. Start forge with a local model configured.', 'warn', 'brain');
      return respond('I have no reasoning layer available, sir.');
    }
    log(`  ${'PROVIDER'.padEnd(14)} ${brain.provider}`, 'sys', 'brain');
    log(`  ${'MODEL'.padEnd(14)} ${brain.model}`, 'sys', 'brain');
    log(`  ${'RUNS LOCALLY'.padEnd(14)} ${brain.local ? 'YES' : 'NO'}`, brain.local ? 'ok' : 'warn', 'brain');
    log(`  ${'TURNS HELD'.padEnd(14)} ${brain.history.length}`, 'sys', 'brain');
    return respond(`Reasoning through ${brain.model}, sir.`);
  },
});
