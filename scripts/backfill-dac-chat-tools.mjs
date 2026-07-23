/**
 * Backfill host-tool timeline onto the imported 8-bit DAC assistant message.
 * Run with Vite on 5173; temporarily owns Electron.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const storageKey = 'actoviq.desktop.chat-history.v2';
const conversationId = 'conv-1784799770791-owgf5h';
const userDataDir = process.env.APPDATA
  ? path.join(process.env.APPDATA, 'actoviq-circuit-agent')
  : path.resolve(root, 'output', 'playwright', 'import-chat-user-data');
const viteUrl = process.env.ACTOVIQ_RENDERER_URL || 'http://127.0.0.1:5173';
const electronDistDir = path.resolve(root, 'node_modules', 'electron', 'dist');

const tools = [
  {
    id: 'host-create-project',
    name: 'create_circuit_project',
    status: 'done',
    label: 'Created 8-bit-r2r-dac',
    detail: '8-bit-r2r-dac',
  },
  {
    id: 'host-apply-transaction',
    name: 'apply_circuit_command',
    status: 'done',
    label: 'Applied revision 1',
    detail: 'upsert_module_netlist · ERC 0 errors, 2 warnings',
  },
  {
    id: 'host-compile',
    name: 'compile_circuit_project',
    status: 'done',
    label: 'Compile complete',
  },
  {
    id: 'host-simulate',
    name: 'simulate_circuit_project',
    status: 'done',
    label: 'Simulation complete',
  },
  {
    id: 'host-technical-report',
    name: 'generate_technical_report',
    status: 'done',
    label: 'Report via deepseek-reasoner',
    detail: 'revision 1',
  },
];

async function waitForUrl(url, timeoutMs = 30_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok || response.status === 404) return;
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function main() {
  await waitForUrl(viteUrl);
  const electronApp = await electron.launch({
    args: [`--user-data-dir=${userDataDir}`, '.'],
    cwd: root,
    env: {
      ...process.env,
      ACTOVIQ_RENDERER_URL: viteUrl,
      PATH: `${electronDistDir}${path.delimiter}${process.env.PATH ?? ''}`,
    },
  });
  try {
    const page = await electronApp.firstWindow();
    await page.waitForSelector('[data-testid="circuit-workbench"]', { timeout: 60_000 });
    const result = await page.evaluate(({ storageKey: key, conversationId: cid, tools: nextTools }) => {
      const raw = localStorage.getItem(key);
      if (!raw) return { ok: false, reason: 'missing-history' };
      const snapshot = JSON.parse(raw);
      const messages = snapshot.conversationMessages?.[cid];
      if (!Array.isArray(messages)) return { ok: false, reason: 'missing-conversation' };
      const assistant = messages.find((entry) => entry.role === 'assistant' && /8-bit-r2r-dac|R-2R/i.test(entry.content || ''));
      if (!assistant) return { ok: false, reason: 'missing-assistant', ids: messages.map((m) => m.id) };
      assistant.tools = nextTools;
      localStorage.setItem(key, JSON.stringify({ ...snapshot, savedAt: Date.now() }));
      return { ok: true, messageId: assistant.id, toolCount: nextTools.length };
    }, { storageKey, conversationId, tools });
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await electronApp.close().catch(() => undefined);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
