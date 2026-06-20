import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';

const left = readFileSync('prototype/ldo_netlistsvg.svg', 'utf8');
const right = readFileSync('prototype/ldo_auto.svg', 'utf8');

const html = `<!doctype html><html><body style="margin:0;background:#fff;font-family:Segoe UI,Arial">
<div style="display:flex;gap:16px;padding:16px;align-items:flex-start">
  <div style="flex:1">
    <div style="font-size:22px;font-weight:700;color:#a32d38;margin-bottom:8px">netlistsvg (current) — 7 overlaps, 9 crossings, 46 intrusions</div>
    <div style="border:1px solid #ccc;padding:8px">${left}</div>
  </div>
  <div style="flex:1">
    <div style="font-size:22px;font-weight:700;color:#267346;margin-bottom:8px">AI grid (auto from netlist + idioms + maze router) — 0 overlaps, 4 crossings, 0 intrusions</div>
    <div style="border:1px solid #ccc;padding:8px">${right}</div>
  </div>
</div></body></html>`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 2400, height: 1100 }, deviceScaleFactor: 1.5 });
await page.setContent(html, { waitUntil: 'networkidle' });
await page.screenshot({ path: 'prototype/comparison.png', fullPage: true });
await browser.close();
console.log('wrote prototype/comparison.png');
