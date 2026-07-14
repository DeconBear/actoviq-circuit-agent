#!/usr/bin/env node
'use strict';

const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow, nativeImage } = require('electron');

app.disableHardwareAcceleration();

async function main() {
  const svgPath = process.argv.at(-2);
  const resultPath = process.argv.at(-1);
  if (!svgPath || !resultPath) {
    throw new Error('Usage: rasterize_schematic.cjs <schematic.svg> <result.json>');
  }
  app.setPath('userData', path.join(os.tmpdir(), `actoviq-rasterizer-${process.pid}`));
  await app.whenReady();
  const resolvedSvgPath = path.resolve(svgPath);
  const directImage = nativeImage.createFromPath(resolvedSvgPath);
  if (!directImage.isEmpty()) {
    const size = directImage.getSize();
    fsSync.writeFileSync(resultPath, JSON.stringify({
      ok: true,
      width: size.width,
      height: size.height,
      png_base64: directImage.toPNG().toString('base64'),
    }));
    setTimeout(() => app.quit(), 1000);
    return;
  }

  const svg = await fs.readFile(resolvedSvgPath, 'utf8');
  const htmlPath = path.join(os.tmpdir(), `actoviq-rasterizer-${process.pid}.html`);
  const html = `<style>html,body{margin:0;background:#fff}svg{display:block;max-width:2400px;max-height:1800px}</style>${svg}`;
  await fs.writeFile(htmlPath, html, 'utf8');
  const window = new BrowserWindow({
    show: false,
    width: 2400,
    height: 1800,
    webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true },
  });
  try {
    await window.loadFile(htmlPath);
    const box = await window.webContents.executeJavaScript(`(() => {
      const svg = document.querySelector('svg');
      if (!svg) return null;
      const bounds = svg.getBoundingClientRect();
      return { width: Math.ceil(bounds.width), height: Math.ceil(bounds.height) };
    })()`);
    if (!box || box.width <= 0 || box.height <= 0) {
      throw new Error('Rendered schematic has no visible SVG bounds.');
    }
    const width = Math.min(2400, Number(box.width));
    const height = Math.min(1800, Number(box.height));
    window.setContentSize(width, height);
    const image = await window.webContents.capturePage({ x: 0, y: 0, width, height });
    fsSync.writeFileSync(resultPath, JSON.stringify({
      ok: true,
      width,
      height,
      png_base64: image.toPNG().toString('base64'),
    }));
  } finally {
    window.destroy();
    await fs.rm(htmlPath, { force: true });
    setTimeout(() => app.quit(), 1000);
  }
}

main().catch((error) => {
  const resultPath = process.argv.at(-1);
  const message = error instanceof Error ? error.stack || error.message : String(error);
  if (resultPath) {
    fsSync.writeFileSync(resultPath, JSON.stringify({ ok: false, error: message }));
  }
  setTimeout(() => app.exit(1), 1000);
});
