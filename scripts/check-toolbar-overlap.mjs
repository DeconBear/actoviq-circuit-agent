import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.resolve(root, 'output', 'playwright', 'toolbar-overlap-check');

await mkdir(outDir, { recursive: true });

const app = await electron.launch({
  args: ['.'],
  cwd: root,
  env: {
    ...process.env,
    ACTOVIQ_USE_BUILT_RENDERER: '1',
    DISPLAY: process.env.DISPLAY || ':1',
  },
});

const page = await app.firstWindow();
await page.setViewportSize({ width: 1400, height: 900 });
await page.waitForSelector('.av-app-toolbar', { timeout: 30000 });
await page.waitForTimeout(1500);

await page.screenshot({ path: path.join(outDir, '01-default.png'), fullPage: false });
await page.locator('.av-app-toolbar').screenshot({ path: path.join(outDir, '01-toolbar.png') });

const chatBtn = page.getByTestId('topbar-chat');
await chatBtn.click();
await page.waitForSelector('[data-testid="chat-drawer"]', { timeout: 10000 });
await page.waitForTimeout(800);

await page.screenshot({ path: path.join(outDir, '02-chat-open.png'), fullPage: false });
await page.locator('.av-app-toolbar').screenshot({ path: path.join(outDir, '02-toolbar-chat.png') });

const metrics = await page.evaluate(() => {
  const toolbar = document.querySelector('.av-app-toolbar');
  const center = document.querySelector('.av-app-toolbar__center');
  const end = document.querySelector('.av-app-toolbar__end');
  const segmented = document.querySelector('.av-app-toolbar__center .av-segmented');
  const labels = [...document.querySelectorAll('.av-segmented__label--responsive')];
  const rect = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height, right: r.right, left: r.left };
  };
  const centerRect = rect(center);
  const endRect = rect(end);
  const overlap = centerRect && endRect
    ? Math.max(0, centerRect.right - endRect.left)
    : null;
  return {
    toolbarWidth: toolbar?.clientWidth ?? null,
    center: centerRect,
    end: endRect,
    segmented: rect(segmented),
    overlapPx: overlap,
    visibleTabLabels: labels.filter((el) => getComputedStyle(el).display !== 'none').map((el) => el.textContent?.trim()),
    statusVisible: (() => {
      const status = document.querySelector('.av-toolbar-status span:not(.av-toolbar-status__dot)');
      return status ? getComputedStyle(status).display !== 'none' : false;
    })(),
  };
});

console.log(JSON.stringify(metrics, null, 2));
await app.close();

if ((metrics.overlapPx ?? 0) > 2) {
  console.error(`FAIL: toolbar center/end overlap ${metrics.overlapPx}px`);
  process.exit(1);
}
if ((metrics.visibleTabLabels?.length ?? 0) > 0 && (metrics.toolbarWidth ?? 9999) < 980) {
  console.error('FAIL: tab labels still visible in narrow toolbar');
  process.exit(1);
}
console.log('PASS: no center/end overlap');
