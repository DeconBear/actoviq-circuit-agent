/**
 * Continue the existing buck chat until modules exist; assert history preserved.
 */
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const projectId = process.env.BUCK_PROJECT_ID || 'buck-converter-react-1784824421118';
const stamp = Date.now();
const outputRoot = path.resolve(root, 'output', 'playwright', `live-buck-continue-${stamp}`);
const userDataDir = process.env.APPDATA
  ? path.join(process.env.APPDATA, 'actoviq-circuit-agent')
  : path.resolve(outputRoot, 'electron-user-data');
const workspaceRoot = path.resolve(root, 'workspace', 'workspaces', 'default');
const projectRoot = path.resolve(workspaceRoot, 'projects', projectId);
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

async function readProject() {
  const raw = await readFile(path.join(projectRoot, 'project.circuit.json'), 'utf8');
  return JSON.parse(raw);
}

async function assistantText(page) {
  return page.locator('.chat-message-row--assistant').allInnerTexts().then((parts) => parts.join('\n')).catch(() => '');
}

async function waitUntil(predicate, { timeoutMs = 12 * 60_000, intervalMs = 2000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await sleep(intervalMs);
  }
  return false;
}

async function main() {
  await mkdir(outputRoot, { recursive: true });

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

    await page.waitForSelector('[data-testid="topbar-tab-design"]', { timeout: 60_000 });
    await page.getByTestId(`sidebar-project-${projectId}`).click();
    await page.getByTestId('circuit-workbench').waitFor({ state: 'visible', timeout: 60_000 });

    const composerVisible = await page.getByTestId('chat-composer').isVisible().catch(() => false);
    if (!composerVisible) {
      await page.getByTestId('topbar-chat').click();
      await page.getByTestId('chat-composer').waitFor({ state: 'visible', timeout: 15_000 });
    }

    // Prefer the existing buck conversation if listed.
    const buckConv = page.locator('[data-testid^="sidebar-conversation-"]', { hasText: /buck|synchronous/i }).first();
    if (await buckConv.isVisible().catch(() => false)) {
      await buckConv.click();
      await sleep(500);
    }

    const tierSelect = page.getByTestId('chat-model-tier');
    if (await tierSelect.isVisible().catch(() => false)) {
      await tierSelect.selectOption({ label: /professional|pro/i }).catch(async () => {
        await tierSelect.selectOption('professional').catch(() => undefined);
      });
    }

    const beforeTranscript = await page.getByTestId('chat-message-list').innerText().catch(() => '');
    const historyHadOriginal = /buck-converter-react-1784824421118|synchronous buck|Vin=12V/i.test(beforeTranscript);

    const prompt = [
      `Continue in THIS conversation for project ${projectId}. Do NOT create a new project.`,
      'Call agent_context first (base_revision), then ONE apply_circuit_command with operations using upsert_module_netlist.',
      'Use this exact shape (adapt values if needed, keep module_id power_stage):',
      'operations: [{',
      '"op":"upsert_module_netlist",',
      '"module_id":"power_stage",',
      '"name":"Power Stage",',
      '"kind":"power",',
      '"function":"open-loop synchronous buck approximator",',
      '"netlist_notebook":"Vsw sw 0 PULSE(0 12 0 1n 1n 4.17u 10u)\\nD1 0 sw Dmod\\nL1 sw out 22u\\nCout out 0 100u\\nRload out 0 5\\n.model Dmod D\\n.tran 100n 500u uic\\n"',
      '}]',
      'Then run_erc, compile_circuit_project, simulate_circuit_project.',
      'Finally reply with L, Cout, duty≈5/12, and sim ok/fail. Keep chat history.',
    ].join(' ');

    await page.getByTestId('chat-composer').fill(prompt);
    await page.screenshot({ path: path.resolve(outputRoot, '01-continue-prompt.png') });
    await page.getByTestId('chat-send').click();
    await page.getByTestId('chat-streaming-message').waitFor({ timeout: 90_000 }).catch(() => null);

    const modulesReady = await waitUntil(async () => {
      try {
        const project = await readProject();
        return Array.isArray(project.modules) && project.modules.length >= 1 && Number(project.revision) >= 1;
      } catch {
        return false;
      }
    }, { timeoutMs: 12 * 60_000 });

    // Wait for agent to go idle after modules appear (or deadline).
    await waitUntil(async () => {
      const streaming = await page.getByTestId('chat-streaming-message').count();
      const stopVisible = await page.getByTestId('chat-stop').isVisible().catch(() => false);
      const text = await assistantText(page);
      const done = /duty|Cout|22\s*u|simulat|ERC|revision\s*[1-9]/i.test(text);
      return streaming === 0 && !stopVisible && (modulesReady ? done || true : done);
    }, { timeoutMs: 4 * 60_000 });

    await sleep(2000);
    await page.screenshot({ path: path.resolve(outputRoot, '02-after-continue.png'), fullPage: true });
    await page.screenshot({ path: path.resolve(outputRoot, '03-workbench.png') });

    const project = await readProject();
    const transcript = await page.getByTestId('chat-message-list').innerText();
    const historyPreserved = historyHadOriginal
      && /buck-converter-react-1784824421118|synchronous buck|Vin=12V/i.test(transcript)
      && transcript.includes('Continue in THIS conversation');

    const summary = {
      ok: modulesReady && historyPreserved && project.modules.length >= 1,
      projectId,
      revision: project.revision,
      moduleIds: project.modules.map((m) => m.id || m.module_id || m),
      modulesReady,
      historyHadOriginal,
      historyPreserved,
      transcriptChars: transcript.length,
      pageErrors,
      transcriptTail: transcript.slice(-5000),
    };
    await writeFile(path.resolve(outputRoot, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
    await writeFile(path.resolve(outputRoot, 'transcript.txt'), transcript, 'utf8');
    console.log(JSON.stringify({ outputRoot, ...summary }, null, 2));
    if (!summary.ok) process.exitCode = 1;
  } finally {
    try { await electronApp.close(); } catch { /* ignore */ }
    vite.kill();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
