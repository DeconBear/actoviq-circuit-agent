/**
 * Live chat smoke: open Electron with real ~/.actoviq settings (DeepSeek key),
 * ask for an 8-bit DAC design via ReAct tools, capture transcript + screenshots.
 */
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stamp = Date.now();
const projectName = `8-bit-r2r-dac-react-${stamp}`;
const outputRoot = path.resolve(root, 'output', 'playwright', `live-dac-${stamp}`);
// Reuse the real Electron user-data so safeStorage can decrypt the stored API key.
const userDataDir = process.env.APPDATA
  ? path.join(process.env.APPDATA, 'actoviq-circuit-agent')
  : path.resolve(outputRoot, 'electron-user-data');
const workspaceRoot = path.resolve(root, 'workspace', 'workspaces', 'default');
const viteBin = path.resolve(root, 'node_modules', 'vite', 'bin', 'vite.js');
const electronDistDir = path.resolve(root, 'node_modules', 'electron', 'dist');

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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  await mkdir(outputRoot, { recursive: true });
  await mkdir(userDataDir, { recursive: true });

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
  const consoleErrors = [];
  const consoleInfo = [];
  const electronApp = await electron.launch({
    args: [`--user-data-dir=${userDataDir}`, '.'],
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
    page.on('console', (msg) => {
      const text = msg.text();
      if (msg.type() === 'error') consoleErrors.push(text);
      if (text.includes('[project-agent]') || text.includes('tool')) consoleInfo.push(text);
    });

    await page.waitForSelector('[data-testid="circuit-workbench"]', { timeout: 60_000 });
    await page.screenshot({ path: path.resolve(outputRoot, '01-workbench.png') });

    // Ensure chat drawer is open.
    const composerVisible = await page.getByTestId('chat-composer').isVisible().catch(() => false);
    if (!composerVisible) {
      await page.getByTestId('topbar-chat').click();
      await page.getByTestId('chat-composer').waitFor({ state: 'visible', timeout: 15_000 });
    }

    await page.getByTestId('chat-new-conversation').click().catch(() => undefined);
    await sleep(300);

    // Prefer Professional / reasoner if the UI exposes a tier control; otherwise Medium.
    const tierSelect = page.getByTestId('chat-model-tier');
    if (await tierSelect.isVisible().catch(() => false)) {
      await tierSelect.selectOption({ label: /professional|pro/i }).catch(async () => {
        await tierSelect.selectOption('professional').catch(() => undefined);
      });
    }

    const prompt = [
      `Design an 8-bit R-2R DAC as a NEW simulation project named ${projectName}.`,
      'Follow the circuit skill protocol with tools:',
      'create_circuit_project (projectKind=simulation) → agent_context → apply_circuit_command → run_erc → compile_circuit_project → simulate_circuit_project.',
      'REQUIRED module split (do NOT use a single monolithic upsert_module_netlist):',
      '1) stimuli module: bit voltage sources Vb0..Vb7 (0/5V) plus .dc analysis;',
      '2) r2r_ladder module: series R=10k and shunt 2R=20k ladder only;',
      '3) optional load module if needed.',
      'Use add_port + connect_ports to wire bit rails and Vout/GND between modules.',
      'Flat SPICE primitives only: R and V. No .subckt, no B/E, no .control/.endc.',
      'After tools finish, state module count, LSB, and full-scale voltage in your reply.',
    ].join(' ');

    await page.getByTestId('chat-composer').fill(prompt);
    await page.screenshot({ path: path.resolve(outputRoot, '02-prompt-ready.png') });
    await page.getByTestId('chat-send').click();

    // Wait for streaming to start, then for ReAct + reply to finish.
    await page.getByTestId('chat-streaming-message').waitFor({ timeout: 90_000 }).catch(() => null);

    const deadline = Date.now() + 12 * 60_000;
    let lastText = '';
    let toolNamesSeen = [];
    while (Date.now() < deadline) {
      const streaming = await page.getByTestId('chat-streaming-message').count();
      const stopVisible = await page.getByTestId('chat-stop').isVisible().catch(() => false);
      lastText = await page.getByTestId('chat-message-list').innerText().catch(() => '');

      toolNamesSeen = await page.evaluate(() => {
        const nodes = [...document.querySelectorAll('[data-testid="chat-tool-item"], .chat-tool, [class*="tool"]')];
        return [...new Set(nodes.map((n) => (n.textContent || '').trim()).filter(Boolean))].slice(0, 40);
      }).catch(() => toolNamesSeen);

      const failed = /Agent error:|Configure an API key|unsupported operation|Chat error:/i.test(lastText);
      // Require assistant completion signals — do not match the user prompt alone.
      const assistantDone = /LSB|full-?scale|module count|revision\s*\d+|simulat(?:e|ion)\s+(?:complete|success)|ERC:\s*\d+/i.test(lastText);
      const projectHint = new RegExp(projectName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(lastText)
        || /create_circuit_project|compile_circuit_project|simulate_circuit/i.test(lastText);

      if (failed && streaming === 0 && !stopVisible) break;
      if (assistantDone && projectHint && streaming === 0 && !stopVisible) break;
      // Only accept idle timeout near the deadline, and require an assistant bubble beyond the user prompt.
      const assistantBubbles = await page.locator('.chat-message-row--assistant').count().catch(() => 0);
      if (streaming === 0 && !stopVisible && assistantBubbles > 0 && assistantDone && Date.now() > deadline - 45_000) break;
      await sleep(2000);
    }

    await sleep(2000);
    await page.screenshot({ path: path.resolve(outputRoot, '03-chat-result.png'), fullPage: true });
    await page.screenshot({ path: path.resolve(outputRoot, '04-workbench.png') });

    const transcript = await page.getByTestId('chat-message-list').innerText();
    const workbench = await page.locator('[data-testid="circuit-workbench"]').getAttribute('data-project-id');
    const activeProjectLabel = await page.locator('[data-testid="circuit-workbench"]').innerText().catch(() => '');

    const toolMentions = {
      create: /create_circuit_project/i.test(transcript),
      agentContext: /agent_context/i.test(transcript),
      apply: /apply_circuit_command/i.test(transcript),
      erc: /run_erc/i.test(transcript),
      compile: /compile_circuit/i.test(transcript),
      simulate: /simulate_circuit/i.test(transcript),
    };

    const summary = {
      ok: true,
      projectName,
      workbenchProjectId: workbench,
      transcriptChars: transcript.length,
      pageErrors,
      consoleErrors: consoleErrors.slice(0, 40),
      consoleInfo: consoleInfo.slice(0, 40),
      toolNamesSeen,
      toolMentions,
      hasDacMention: /dac|r-?2r|ladder/i.test(transcript),
      hasModuleSplitMention: /stimuli|connect_ports|add_port|modules?/i.test(transcript),
      hasErrorLike: /error|failed|401|unauthorized|invalid/i.test(transcript),
      transcriptTail: transcript.slice(-5000),
    };
    await writeFile(path.resolve(outputRoot, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
    await writeFile(path.resolve(outputRoot, 'transcript.txt'), transcript, 'utf8');
    await writeFile(path.resolve(outputRoot, 'workbench-snippet.txt'), activeProjectLabel.slice(0, 5000), 'utf8');
    console.log(JSON.stringify({ outputRoot, ...summary }, null, 2));
  } finally {
    try { await electronApp.close(); } catch { /* ignore */ }
    vite.kill();
  }
}

main().catch(async (error) => {
  console.error(error);
  process.exitCode = 1;
});
