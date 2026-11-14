/**
 * Screenshot preview pages with your installed Chrome, waiting until the page sets document.title = 'ready'.
 *   npx tsx scripts/arm/render.ts <url> <out.png> [width] [height] [fullPage]
 * Needs a static server on the repo root (e.g. python3 -m http.server 8765) or the Vite dev server.
 */
import puppeteer from 'puppeteer-core';

const [url, out, w = '1600', h = '1000', full] = process.argv.slice(2);
if (!url || !out) {
  console.error('usage: render.ts <url> <out.png> [width] [height] [fullPage]');
  process.exit(1);
}
const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--hide-scrollbars'],
});
try {
  const page = await browser.newPage();
  await page.setViewport({ width: Number(w), height: Number(h), deviceScaleFactor: 1 });
  page.on('pageerror', (e) => console.error('[page error]', e.message));
  await page.goto(url, { waitUntil: 'load', timeout: 120000 });
  await page.waitForFunction(() => document.title === 'ready', { timeout: 300000 });
  await new Promise((r) => setTimeout(r, 300));
  await page.screenshot({ path: out as `${string}.png`, fullPage: !!full });
  console.log(out);
} finally {
  await browser.close();
}
