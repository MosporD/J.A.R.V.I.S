import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { launch, openDashboard, brightness, waitForLog } from './browser.mjs';

const PORT = Number(process.env.JARVIS_TEST_PORT || 4188);
const URL = `http://127.0.0.1:${PORT}/`;

let server;
let browser;

/** Wait for the preview server to answer, rather than sleeping and hoping. */
async function waitForServer(timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(URL);
      if (response.ok) return;
    } catch { /* not up yet */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`preview server did not come up on ${URL}`);
}

before(async () => {
  server = spawn(
    process.platform === 'win32' ? 'npx.cmd' : 'npx',
    ['vite', 'preview', '--port', String(PORT), '--strictPort'],
    { stdio: 'ignore', detached: process.platform !== 'win32' },
  );
  await waitForServer();
  browser = await launch();
});

after(async () => {
  await browser?.close();
  if (!server) return;
  // Kill the whole group: npx spawns vite as a child, and killing only npx
  // leaves the server holding the port for the next run.
  try {
    if (process.platform === 'win32') server.kill();
    else process.kill(-server.pid, 'SIGTERM');
  } catch { /* already gone */ }
});

/**
 * Stand in for forge's /brain endpoint.
 *
 * `replies` is consumed one turn at a time, so a test can script "ask for a
 * tool, then answer". Every posted transcript is recorded, which is how the
 * tool-result round trip is checked.
 */
async function stubBrain(page, replies, { status = 200, ready = true } = {}) {
  const posted = [];
  const queue = [...replies];
  await page.route('**/brain', async (route) => {
    const request = route.request();
    if (request.method() === 'GET') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ready, provider: 'ollama', model: 'qwen2.5:7b-instruct', local: true }),
      });
    }
    posted.push(request.postDataJSON());
    if (status !== 200) {
      return route.fulfill({
        status,
        contentType: 'application/json',
        body: JSON.stringify({ detail: 'connection refused' }),
      });
    }
    const next = queue.shift() || { reply: 'Nothing further, sir.', tool_calls: [] };
    return route.fulfill({
      status: 200, contentType: 'application/json', body: JSON.stringify(next),
    });
  });
  return posted;
}

/** Everything the log currently shows. */
const logText = (page) =>
  page.evaluate(() => document.querySelector('[data-log-stream]')?.textContent || '');

test('the dashboard boots and exposes its runtime', async () => {
  const { page, errors } = await openDashboard(browser, { url: URL });
  const ready = await page.evaluate(() => Boolean(window.JARVIS?.store));
  assert.ok(ready, 'window.JARVIS should be exposed once the kernel is up');
  assert.deepEqual(errors, [], 'the console should be clean');
  await page.close();
});

test('the boot overlay does not strand the operator', async () => {
  const { page } = await openDashboard(browser, { url: URL });
  const booted = await page.evaluate(() => window.JARVIS.store.get('booted'));
  assert.equal(booted, true, 'boot should have completed or been skipped');
  await page.close();
});

test('the 3D core mounts on a WebGL display and is lit', async () => {
  const { page, errors } = await openDashboard(browser, { url: URL });
  const is3D = await page.evaluate(() => {
    const canvas = document.querySelector('#core canvas');
    return Boolean(canvas && (canvas.getContext('webgl2') || canvas.getContext('webgl')));
  });
  assert.ok(is3D, 'the 3D core should have replaced the flat one');
  const lit = await brightness(page, '#core');
  assert.ok(lit > 20, `the core should be rendering, mean brightness ${lit.toFixed(1)}`);
  assert.deepEqual(errors, []);
  await page.close();
});

test('the flat core renders when WebGL is unavailable', async () => {
  const { page, errors } = await openDashboard(browser, { url: URL, webgl: false });
  const lit = await brightness(page, '#core');
  assert.ok(lit > 20, `the flat core should render, mean brightness ${lit.toFixed(1)}`);
  assert.deepEqual(errors, []);
  await page.close();
});

test('losing the render context falls back to the flat core', async () => {
  const { page } = await openDashboard(browser, { url: URL });
  await page.evaluate(() => {
    const canvas = document.querySelector('#core canvas');
    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
    gl.getExtension('WEBGL_lose_context').loseContext();
  });
  await page.waitForTimeout(1500);
  const flat = await page.evaluate(() => {
    try { return Boolean(document.querySelector('#core canvas').getContext('2d')); }
    catch { return false; }
  });
  assert.ok(flat, 'a 2D context should have taken over');
  await page.close();
});

test('the core still renders under prefers-reduced-motion', async () => {
  const { page, errors } = await openDashboard(browser, { url: URL, reducedMotion: true });
  const lit = await brightness(page, '#core');
  assert.ok(lit > 20, `reduced motion should slow the core, not stop it (${lit.toFixed(1)})`);
  assert.deepEqual(errors, []);
  await page.close();
});

test('the core survives a portrait resize', async () => {
  const { page, errors } = await openDashboard(browser, { url: URL });
  await page.setViewportSize({ width: 900, height: 1200 });
  await page.waitForTimeout(900);
  const lit = await brightness(page, '#core');
  assert.ok(lit > 20, `the core should still render when narrow (${lit.toFixed(1)})`);
  assert.deepEqual(errors, []);
  await page.close();
});

test('the gesture toggle starts closed and is labelled', async () => {
  const { page } = await openDashboard(browser, { url: URL });
  const state = await page.evaluate(() => {
    const button = document.querySelector('#gesture-toggle');
    return { text: button?.textContent.trim(), pressed: button?.getAttribute('aria-pressed') };
  });
  assert.equal(state.pressed, 'false');
  assert.match(state.text, /OPTICS/);
  await page.close();
});

test('opening the camera drives the gesture pipeline end to end', async () => {
  const { page, errors } = await openDashboard(browser, { url: URL });
  const started = await page.evaluate(() => window.JARVIS.gestures.start());
  assert.ok(started, 'the fake camera should open');
  assert.equal(await page.evaluate(() => window.JARVIS.store.get('gesturing')), true);

  // The synthetic camera feed moves, so the detector should be measuring
  // something rather than sitting at zero.
  await page.waitForTimeout(1200);
  const sampled = await page.evaluate(
    () => window.JARVIS.gestures.detector.previous !== null,
  );
  assert.ok(sampled, 'frames should be reaching the detector');

  await page.evaluate(() => window.JARVIS.gestures.stop());
  assert.equal(await page.evaluate(() => window.JARVIS.store.get('gesturing')), false);
  assert.equal(await page.evaluate(() => window.JARVIS.store.get('motion')), 0);
  assert.deepEqual(errors, []);
  await page.close();
});

test('stopping the camera releases the hardware', async () => {
  const { page } = await openDashboard(browser, { url: URL });
  await page.evaluate(() => window.JARVIS.gestures.start());
  await page.evaluate(() => window.JARVIS.gestures.stop());
  const released = await page.evaluate(() => ({
    stream: window.JARVIS.gestures.stream,
    video: document.querySelectorAll('video').length,
  }));
  assert.equal(released.stream, null, 'the media stream should be dropped');
  assert.equal(released.video, 0, 'the hidden video element should be removed');
  await page.close();
});

test('the gesture directive lists its bindings', async () => {
  const { page } = await openDashboard(browser, { url: URL });
  await page.evaluate(() => window.JARVIS.execute('gesture list'));
  await page.waitForTimeout(400);
  const text = await page.evaluate(() => document.querySelector('[data-log-stream]')?.textContent || '');
  assert.match(text, /swipe-up/);
  await page.close();
});

test('core directives run without error', async () => {
  const { page, errors } = await openDashboard(browser, { url: URL });
  for (const directive of ['help', 'status', 'keys', 'clear']) {
    await page.evaluate((name) => window.JARVIS.execute(name), directive);
    await page.waitForTimeout(150);
  }
  assert.deepEqual(errors, []);
  await page.close();
});


// --- the reasoning layer ----------------------------------------------------

test('the assistant reports itself reachable when forge answers', async () => {
  const { page } = await openDashboard(browser, { url: URL });
  await stubBrain(page, []);
  const ready = await page.evaluate(() => window.JARVIS.brain.probe());
  assert.equal(ready, true);
  assert.equal(await page.evaluate(() => window.JARVIS.store.get('brain')), true);
  await page.close();
});

test('an unreachable forge leaves the prompt working rather than throwing', async () => {
  const { page, errors } = await openDashboard(browser, { url: URL });
  await page.route('**/brain', (route) => route.abort());
  const ready = await page.evaluate(() => window.JARVIS.brain.probe());
  assert.equal(ready, false);
  assert.equal(await page.evaluate(() => window.JARVIS.store.get('brain')), false);
  assert.deepEqual(errors, []);
  await page.close();
});

test('a plain answer is spoken back', async () => {
  const { page } = await openDashboard(browser, { url: URL });
  await stubBrain(page, [{ reply: 'All systems nominal, sir.', tool_calls: [] }]);
  const reply = await page.evaluate(() => window.JARVIS.brain.ask('how are we doing'));
  assert.equal(reply, 'All systems nominal, sir.');
  await waitForLog(page, /All systems nominal/);
  await page.close();
});

test('a tool call runs the directive and its output goes back to the model', async () => {
  const { page } = await openDashboard(browser, { url: URL });
  const posted = await stubBrain(page, [
    { reply: '', tool_calls: [{ id: 'c1', name: 'theme', arguments: { arguments: 'amber' } }] },
    { reply: 'Palette changed, sir.', tool_calls: [] },
  ]);
  const reply = await page.evaluate(() => window.JARVIS.brain.ask('make it amber'));
  assert.equal(reply, 'Palette changed, sir.');

  // The directive actually ran.
  const hue = await page.evaluate(
    () => document.documentElement.style.getPropertyValue('--color-hud').trim(),
  );
  assert.equal(hue, '#ffb000');

  // And the second turn carried the tool result back.
  assert.equal(posted.length, 2);
  const followUp = posted[1].messages;
  const toolMessage = followUp.find((m) => m.role === 'tool');
  assert.ok(toolMessage, 'the transcript should carry a tool result');
  assert.equal(toolMessage.tool_call_id, 'c1');
  const assistantTurn = followUp.find((m) => m.role === 'assistant' && m.tool_calls);
  assert.ok(assistantTurn, 'the request that produced the result must be in the transcript too');
  await page.close();
});

test('the registry is what the model is offered as tools', async () => {
  const { page } = await openDashboard(browser, { url: URL });
  const posted = await stubBrain(page, [{ reply: 'ok', tool_calls: [] }]);
  await page.evaluate(() => window.JARVIS.brain.ask('anything'));
  const names = posted[0].tools.map((t) => t.name);
  for (const expected of ['help', 'status', 'diag', 'theme']) {
    assert.ok(names.includes(expected), `${expected} should be offered as a tool`);
  }
  assert.ok(posted[0].context.telemetry, 'live state should ride along');
  await page.close();
});

test('an invented directive is refused and explained, not executed', async () => {
  const { page } = await openDashboard(browser, { url: URL });
  const posted = await stubBrain(page, [
    { reply: '', tool_calls: [{ id: 'c1', name: 'self_destruct', arguments: {} }] },
    { reply: 'Understood, sir.', tool_calls: [] },
  ]);
  await page.evaluate(() => window.JARVIS.brain.ask('destroy everything'));
  const toolMessage = posted[1].messages.find((m) => m.role === 'tool');
  assert.match(toolMessage.content, /no directive called/);
  await page.close();
});

test('unparseable arguments are handed back for another attempt', async () => {
  const { page } = await openDashboard(browser, { url: URL });
  const posted = await stubBrain(page, [
    { reply: '', tool_calls: [{ id: 'c1', name: 'status', arguments: {}, _error: 'arguments were not valid JSON' }] },
    { reply: 'Corrected, sir.', tool_calls: [] },
  ]);
  await page.evaluate(() => window.JARVIS.brain.ask('status please'));
  const toolMessage = posted[1].messages.find((m) => m.role === 'tool');
  assert.match(toolMessage.content, /not valid JSON/);
  await page.close();
});

test('a model that only ever calls tools is cut off rather than looping', async () => {
  const { page } = await openDashboard(browser, { url: URL });
  const forever = Array.from({ length: 8 }, () => ({
    reply: '', tool_calls: [{ id: 'c', name: 'status', arguments: { arguments: '' } }],
  }));
  const posted = await stubBrain(page, forever);
  const reply = await page.evaluate(() => window.JARVIS.brain.ask('loop forever'));
  assert.match(reply, /could not settle/);
  assert.ok(posted.length <= 4, `should stop after a few rounds, took ${posted.length}`);
  await page.close();
});

test('a 503 from forge is reported, not thrown', async () => {
  const { page, errors } = await openDashboard(browser, { url: URL });
  await stubBrain(page, [], { status: 503 });
  const reply = await page.evaluate(() => window.JARVIS.brain.ask('anything'));
  assert.equal(reply, null);
  await waitForLog(page, /unreachable/i);
  assert.equal(await page.evaluate(() => window.JARVIS.store.get('brain')), false);
  assert.deepEqual(errors, []);
  await page.close();
});

test('an unrecognised line reaches the assistant instead of the canned refusal', async () => {
  const { page } = await openDashboard(browser, { url: URL });
  await stubBrain(page, [{ reply: 'The reactor is holding, sir.', tool_calls: [] }]);
  await page.evaluate(() => window.JARVIS.execute('what is the reactor doing'));
  await waitForLog(page, /The reactor is holding/);
  assert.doesNotMatch(await logText(page), /not in my index/);
  await page.close();
});

test('with no assistant the prompt still gives its canned refusal', async () => {
  const { page } = await openDashboard(browser, { url: URL });
  await page.route('**/brain', (route) => route.abort());
  await page.evaluate(() => window.JARVIS.execute('what is the reactor doing'));
  await waitForLog(page, /not in my index|did not recognise|outside my current directive/);
  await page.close();
});

test('the assistant forgets on request', async () => {
  const { page } = await openDashboard(browser, { url: URL });
  await stubBrain(page, [{ reply: 'Noted, sir.', tool_calls: [] }]);
  await page.evaluate(() => window.JARVIS.brain.ask('remember this'));
  assert.ok(await page.evaluate(() => window.JARVIS.brain.history.length > 0));
  await page.evaluate(() => window.JARVIS.execute('brain forget'));
  await page.waitForTimeout(300);
  assert.equal(await page.evaluate(() => window.JARVIS.brain.history.length), 0);
  await page.close();
});


test('interrupting a spoken reply settles it rather than stranding the caller', async () => {
  // Regression: `cancel()` cleared the timer that resolved an utterance but
  // never settled its promise, so a second reply arriving before the first had
  // finished left `execute()` awaiting forever and the core stuck processing.
  const { page } = await openDashboard(browser, { url: URL });
  const settled = await page.evaluate(async () => {
    const { speech } = window.JARVIS;
    const first = speech.speak('A long line that would take a while to read aloud.');
    let done = false;
    first.then(() => { done = true; });
    speech.speak('Interrupting.');          // cancels the first
    await new Promise((r) => setTimeout(r, 50));
    return done;
  });
  assert.equal(settled, true, 'the interrupted line should have settled');

  // And the mode must come back, since that is what the stall looked like.
  await page.evaluate(() => window.JARVIS.speech.cancel());
  await page.waitForTimeout(200);
  const mode = await page.evaluate(() => window.JARVIS.store.get('mode'));
  assert.notEqual(mode, 'speaking');
  await page.close();
});

test('several directives in a row all complete', async () => {
  // The assistant runs directives back to back, which is what exposed the
  // interruption bug above: each reply cancelled the last.
  const { page } = await openDashboard(browser, { url: URL });
  const finished = await page.evaluate(async () => {
    for (const directive of ['status', 'status', 'diag', 'status']) {
      await window.JARVIS.execute(directive);
    }
    return true;
  });
  assert.equal(finished, true);
  await page.close();
});
