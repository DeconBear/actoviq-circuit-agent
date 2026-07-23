/**
 * Electron check: multi-turn chat transcript stays visible in chat-message-list.
 * Seeds two complete turns via localStorage (no live LLM), opens chat, asserts both.
 *
 * Run: node scripts/playwright-chat-multiturn.mjs
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stamp = Date.now();
const outputRoot = path.resolve(root, 'output', 'playwright', `chat-multiturn-${stamp}`);
const userDataDir = path.resolve(outputRoot, 'electron-user-data');
const workspaceRoot = path.resolve(outputRoot, 'workspace');
const viteBin = path.resolve(root, 'node_modules', 'vite', 'bin', 'vite.js');
const electronDistDir = path.resolve(root, 'node_modules', 'electron', 'dist');
const storageKey = 'actoviq.desktop.chat-history.v2';

const conversationId = `conv-multiturn-${stamp}`;
const prompt1 = `MULTI_TURN_PROMPT_ONE_${stamp}: design a tiny RC filter`;
const reply1 = `MULTI_TURN_REPLY_ONE_${stamp}: created the filter project`;
const prompt2 = `MULTI_TURN_PROMPT_TWO_${stamp}: confirm cutoff frequency`;
const reply2 = `MULTI_TURN_REPLY_TWO_${stamp}: cutoff is about 1 kHz`;

async function allocatePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 5173;
      server.close(() => resolve(port));
    });
  });
}

async function waitForUrl(url, timeoutMs = 60_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok || response.status === 404) return;
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function main() {
  await mkdir(outputRoot, { recursive: true });
  await mkdir(workspaceRoot, { recursive: true });

  const port = await allocatePort();
  const viteUrl = `http://127.0.0.1:${port}`;
  const vite = spawn(process.execPath, [viteBin, '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
    cwd: root,
    env: { ...process.env, BROWSER: 'none' },
    stdio: 'ignore',
    windowsHide: true,
  });
  await waitForUrl(viteUrl);

  const pageErrors = [];
  const electronApp = await electron.launch({
    args: [
      `--user-data-dir=${userDataDir}`,
      '--no-sandbox',
      '--disable-gpu-sandbox',
      '--disable-features=LocalNetworkAccessChecks,BlockInsecurePrivateNetworkRequests',
      '--allow-file-access-from-files',
      '.',
    ],
    cwd: root,
    env: {
      ...process.env,
      ACTOVIQ_RENDERER_URL: viteUrl,
      ACTOVIQ_CIRCUIT_AGENT_WORKSPACE_ROOT: workspaceRoot,
      ELECTRON_ENABLE_LOGGING: '1',
      PATH: `${electronDistDir}${path.delimiter}${process.env.PATH ?? ''}`,
    },
  });

  try {
    const page = await electronApp.firstWindow();
    page.setDefaultTimeout(60_000);
    page.on('pageerror', (error) => pageErrors.push(String(error)));

    await page.waitForSelector('[data-testid="topbar-chat"]', { timeout: 60_000 });

    const snapshot = {
      version: 2,
      conversationId,
      conversations: [{
        id: conversationId,
        title: prompt1.slice(0, 50),
        lastMessage: reply2,
        messageCount: 4,
        updatedAt: stamp,
        titleLocked: false,
        projectId: null,
      }],
      conversationMessages: {
        [conversationId]: [
          { id: `u1-${stamp}`, role: 'user', content: prompt1, timestamp: stamp - 4000, conversationId },
          {
            id: `a1-${stamp}`,
            role: 'assistant',
            content: reply1,
            timestamp: stamp - 3000,
            conversationId,
            tools: [{ id: 't1', name: 'create_circuit_project', status: 'done', label: 'Creating circuit project' }],
          },
          { id: `u2-${stamp}`, role: 'user', content: prompt2, timestamp: stamp - 2000, conversationId },
          { id: `a2-${stamp}`, role: 'assistant', content: reply2, timestamp: stamp - 1000, conversationId },
        ],
      },
      activeConversationByProject: {},
      savedAt: stamp,
    };

    // Seed before renderer hydrate on the next load (beats the 250ms persist race).
    await page.addInitScript(({ key, value }) => {
      localStorage.setItem(key, value);
    }, { key: storageKey, value: JSON.stringify(snapshot) });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-testid="topbar-chat"]', { timeout: 60_000 });

    const composerVisible = await page.getByTestId('chat-composer').isVisible().catch(() => false);
    if (!composerVisible) {
      await page.getByTestId('topbar-chat').click();
    }
    await page.getByTestId('chat-composer').waitFor({ state: 'visible', timeout: 15_000 });
    await page.getByTestId('chat-message-list').waitFor({ state: 'visible', timeout: 15_000 });

    const transcript = await page.getByTestId('chat-message-list').innerText();
    const userRows = await page.locator('.chat-message-row--user').count();
    const assistantRows = await page.locator('.chat-message-row--assistant').count();

    await page.screenshot({ path: path.resolve(outputRoot, '01-multiturn-transcript.png'), fullPage: true });

    assert.equal(userRows, 2, `expected 2 user rows, got ${userRows}`);
    assert.equal(assistantRows, 2, `expected 2 assistant rows, got ${assistantRows}`);
    assert.ok(transcript.includes(prompt1), 'prompt1 missing from transcript');
    assert.ok(transcript.includes(reply1), 'reply1 missing from transcript');
    assert.ok(transcript.includes(prompt2), 'prompt2 missing from transcript');
    assert.ok(transcript.includes(reply2), 'reply2 missing from transcript');
    assert.ok(transcript.includes('create_circuit_project'), 'tool timeline missing from turn 1');

    const summary = {
      ok: true,
      userRows,
      assistantRows,
      transcriptChars: transcript.length,
      pageErrors,
      outputRoot,
    };
    await writeFile(path.resolve(outputRoot, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
    await writeFile(path.resolve(outputRoot, 'transcript.txt'), transcript, 'utf8');
    console.log(JSON.stringify(summary, null, 2));
  } finally {
    try { await electronApp.close(); } catch { /* ignore */ }
    vite.kill();
  }
}

main().catch(async (error) => {
  console.error(error);
  try {
    await mkdir(outputRoot, { recursive: true });
    await writeFile(
      path.resolve(outputRoot, 'summary.json'),
      `${JSON.stringify({ ok: false, error: String(error) }, null, 2)}\n`,
      'utf8',
    );
  } catch { /* ignore */ }
  process.exitCode = 1;
});
