import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { launch, openDashboard, brightness } from './browser.mjs';

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
