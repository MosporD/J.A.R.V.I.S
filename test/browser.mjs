import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';

/**
 * Find a Chromium this machine actually has.
 *
 * Playwright resolves a build number pinned to its own version, which is not
 * necessarily the build that is installed — a CI image or a dev container
 * often ships one Playwright downloaded earlier. Rather than pinning the
 * package to whatever a given machine happens to hold, look for a browser in
 * the order of most specific to most forgiving, and say which one was used.
 */
export function findChromium() {
  if (process.env.JARVIS_CHROMIUM) return process.env.JARVIS_CHROMIUM;

  const expected = chromium.executablePath();
  if (expected && existsSync(expected)) return expected;

  const root = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (root && existsSync(root)) {
    const builds = readdirSync(root)
      .filter((name) => name.startsWith('chromium-'))
      .sort()
      .reverse();
    for (const build of builds) {
      for (const layout of ['chrome-linux64/chrome', 'chrome-linux/chrome',
        'chrome-win/chrome.exe', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium']) {
        const candidate = join(root, build, layout);
        if (existsSync(candidate)) return candidate;
      }
    }
  }
  // Nothing found — let Playwright try the system Chrome and report properly.
  return null;
}

/** Launch a browser configured for a WebGL dashboard in software rendering. */
export async function launch() {
  const executablePath = findChromium();
  return chromium.launch({
    ...(executablePath ? { executablePath } : { channel: 'chrome' }),
    args: [
      // SwiftShader, so the 3D core renders on a machine with no GPU.
      '--use-gl=swiftshader',
      '--enable-unsafe-swiftshader',
      '--no-sandbox',
      // A synthetic camera and microphone, so gesture and voice paths can be
      // driven without hardware and without a permission prompt.
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      // Keep the browser off the network; nothing here needs it.
      '--disable-background-networking',
      '--no-first-run',
      '--disable-sync',
    ],
  });
}

/**
 * Open the dashboard, past the boot overlay and with the core settled.
 *
 * `domcontentloaded`, never `networkidle` — `forge.start()` polls a pipeline
 * that is not running in a test, so the network never goes idle and a
 * networkidle wait times out on a page that is working perfectly.
 */
export async function openDashboard(browser, { url, reducedMotion, webgl = true } = {}) {
  const page = await browser.newPage({
    viewport: { width: 1600, height: 1000 },
    permissions: ['camera'],
    reducedMotion: reducedMotion ? 'reduce' : 'no-preference',
  });

  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const text = message.text();
    // "Failed to load resource" is the browser narrating a network outcome,
    // not the page throwing. Several tests block or fail a request on purpose
    // to check the dashboard copes, and the forge pipeline is never running in
    // a test, so its polling fails throughout. An actual fault still arrives
    // either as a pageerror or as a console.error the dashboard itself wrote.
    if (text.startsWith('Failed to load resource')) return;
    if (text.includes('ERR_CONNECTION_REFUSED')) return;
    errors.push(text);
  });

  if (!webgl) {
    await page.addInitScript(() => {
      HTMLCanvasElement.prototype.getContext = new Proxy(
        HTMLCanvasElement.prototype.getContext,
        { apply: (target, self, args) =>
          (String(args[0]).startsWith('webgl') ? null : Reflect.apply(target, self, args)) },
      );
    });
  }

  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => Boolean(window.JARVIS), null, { timeout: 15000 });
  // Skip the boot sequence rather than waiting it out.
  await page.keyboard.press('Enter').catch(() => {});
  await page.waitForTimeout(2500);
  return { page, errors };
}

/**
 * Mean brightness of the middle of an element, from its composited screenshot.
 *
 * Not `readPixels`. On a WebGL canvas without `preserveDrawingBuffer` the
 * drawing buffer reads back as zeros once the frame has been composited, so a
 * check written that way reports a black core that is rendering perfectly.
 */
export async function brightness(page, selector) {
  const element = await page.$(selector);
  const shot = (await element.screenshot()).toString('base64');
  return page.evaluate(async (data) => {
    const image = new Image();
    image.src = `data:image/png;base64,${data}`;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(image, 0, 0);
    const side = Math.floor(Math.min(image.width, image.height) / 4);
    const { data: pixels } = ctx.getImageData(
      Math.floor(image.width / 2 - side / 2),
      Math.floor(image.height / 2 - side / 2),
      side, side,
    );
    let sum = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      sum += (pixels[i] + pixels[i + 1] + pixels[i + 2]) / 3;
    }
    return sum / (pixels.length / 4);
  }, shot);
}


/**
 * Wait for the event stream to show something.
 *
 * J.A.R.V.I.S. types its replies out a character at a time, so reading the log
 * immediately after a directive returns catches it mid-word.
 */
export async function waitForLog(page, pattern, timeout = 10000) {
  await page.waitForFunction(
    (source) => new RegExp(source).test(
      document.querySelector('[data-log-stream]')?.textContent || '',
    ),
    pattern.source,
    { timeout },
  );
}
