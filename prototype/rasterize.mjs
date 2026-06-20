import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';

const [, , svgPath, outPath] = process.argv;
const svg = readFileSync(svgPath, 'utf8');
const browser = await chromium.launch();
const page = await browser.newPage({ deviceScaleFactor: 2 });
await page.setContent(
  `<!doctype html><html><body style="margin:0;background:#fff;display:inline-block">${svg}</body></html>`,
  { waitUntil: 'networkidle' },
);
const el = (await page.$('svg')) ?? page;
await el.screenshot({ path: outPath });
await browser.close();
console.log('wrote', outPath);
