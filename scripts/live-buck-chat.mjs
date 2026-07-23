/**
 * Live chat: design a buck converter via Electron ReAct tools.
 * Also asserts chat history survives project create/reload (preserveChat).
 */
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stamp = Date.now();
const projectName = `buck-converter-react-${stamp}`;
const outputRoot = path.resolve(root, 'output', 'playwright', `live-buck-${stamp}`);
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

async function readProjectIfExists(projectId) {
  const file = path.resolve(workspaceRoot, 'projects', projectId, 'project.circuit.json');
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

async function assistantText(page) {
  return page.locator('.chat-message-row--assistant').allInnerTexts()
    .then((parts) => parts.join('\n\n'))
    .catch(() => '');
}

async function ensureChatOpen(page) {
  const listVisible = await page.getByTestId('chat-message-list').isVisible().catch(() => false);
  const composerVisible = await page.getByTestId('chat-composer').isVisible().catch(() => false);
  if (listVisible && composerVisible) return;
  await page.getByTestId('topbar-chat').click().catch(() => undefined);
  await page.getByTestId('chat-composer').waitFor({ state: 'visible', timeout: 15_000 }).catch(() => undefined);
}

async function waitForDesignComplete(page, projectId, { deadlineMs = 14 * 60_000 } = {}) {
  const deadline = Date.now() + deadlineMs;
  const started = Date.now();
  let toolNamesSeen = [];
  let lastAssistant = '';
  let nudged = false;
  while (Date.now() < deadline) {
    await ensureChatOpen(page);
    const streaming = await page.getByTestId('chat-streaming-message').count();
    const stopVisible = await page.getByTestId('chat-stop').isVisible().catch(() => false);
    lastAssistant = await assistantText(page);
    toolNamesSeen = await page.evaluate(() => {
      const nodes = [...document.querySelectorAll('[data-testid="chat-tool-item"]')];
      return [...new Set(nodes.map((n) => (n.textContent || '').trim()).filter(Boolean))].slice(0, 40);
    }).catch(() => toolNamesSeen);

    const failed = /Agent error:|Configure an API key|Chat error:/i.test(lastAssistant);
    const project = await readProjectIfExists(projectId);
    const modulesReady = Boolean(project && Array.isArray(project.modules) && project.modules.length >= 1 && Number(project.revision) >= 1);
    const assistantDone = /duty|22\s*u|100\s*u|simulat(?:e|ion).*(?:ok|success|complete)|ERC/i.test(lastAssistant);

    // Same-conversation nudge if create succeeded but upsert stalled.
    if (!nudged && !modulesReady && streaming === 0 && !stopVisible && Date.now() - started > 90_000) {
      nudged = true;
      const nudge = [
        `Continue in THIS conversation for project ${projectId}. Do NOT create a new project.`,
        'Call agent_context, then ONE apply_circuit_command with:',
        'operations:[{"op":"upsert_module_netlist","module_id":"power_stage","name":"Power Stage","kind":"power","function":"open-loop buck","netlist_notebook":"Vsw sw 0 PULSE(0 12 0 1n 1n 4.17u 10u)\\nD1 0 sw Dmod\\nL1 sw out 22u\\nCout out 0 100u\\nRload out 0 5\\n.model Dmod D\\n.tran 100n 500u uic\\n"}]',
        'Then compile_circuit_project and simulate_circuit_project. Reply with L, Cout, duty, sim ok/fail.',
      ].join(' ');
      await page.getByTestId('chat-composer').fill(nudge);
      await page.getByTestId('chat-send').click();
      await page.getByTestId('chat-streaming-message').waitFor({ timeout: 90_000 }).catch(() => null);
    }

    if (failed && streaming === 0 && !stopVisible) {
      return { lastAssistant, toolNamesSeen, modulesReady, failed: true, nudged };
    }
    if (modulesReady && streaming === 0 && !stopVisible && (assistantDone || Date.now() > deadline - 60_000)) {
      return { lastAssistant, toolNamesSeen, modulesReady, failed: false, nudged };
    }
    await sleep(2000);
  }
  const project = await readProjectIfExists(projectId);
  return {
    lastAssistant,
    toolNamesSeen,
    modulesReady: Boolean(project && project.modules?.length >= 1),
    failed: false,
    nudged,
  };
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
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });

    await page.waitForSelector('[data-testid="topbar-tab-design"]', { timeout: 60_000 });
    await page.getByTestId('topbar-tab-design').click().catch(() => undefined);
    const hubReady = page.locator('[data-testid="circuit-workbench"], [data-testid="circuit-empty-state"]');
    await hubReady.first().waitFor({ state: 'visible', timeout: 60_000 }).catch(async () => {
      const firstProject = page.locator('[data-testid^="sidebar-project-"]').first();
      if (await firstProject.isVisible().catch(() => false)) {
        await firstProject.click();
        await hubReady.first().waitFor({ state: 'visible', timeout: 60_000 });
      }
    });
    await page.screenshot({ path: path.resolve(outputRoot, '01-workbench.png') });

    const composerVisible = await page.getByTestId('chat-composer').isVisible().catch(() => false);
    if (!composerVisible) {
      await page.getByTestId('topbar-chat').click();
      await page.getByTestId('chat-composer').waitFor({ state: 'visible', timeout: 15_000 });
    }

    await page.getByTestId('chat-new-conversation').click().catch(() => undefined);
    await sleep(400);

    const tierSelect = page.getByTestId('chat-model-tier');
    if (await tierSelect.isVisible().catch(() => false)) {
      await tierSelect.selectOption({ label: /professional|pro/i }).catch(async () => {
        await tierSelect.selectOption('professional').catch(() => undefined);
      });
    }

    const prompt = [
      `Design a synchronous buck DC-DC converter as a NEW simulation project named ${projectName}.`,
      'Specs: Vin=12V, Vout=5V, Iload≈1A, fsw≈100kHz (ideal switched open-loop model is fine).',
      'Protocol: create_circuit_project → agent_context → apply_circuit_command → run_erc → compile_circuit_project → simulate_circuit_project.',
      'For apply_circuit_command, pass operations[] with upsert_module_netlist and netlist_notebook as ONE plain string.',
      'Use exactly this notebook (module_id power_stage):',
      'Vsw sw 0 PULSE(0 12 0 1n 1n 4.17u 10u)\\nD1 0 sw Dmod\\nL1 sw out 22u\\nCout out 0 100u\\nRload out 0 5\\n.model Dmod D\\n.tran 100n 500u uic',
      'After tools finish, report L, Cout, duty≈5/12, and simulation ok/fail.',
      'Keep this same chat bound to the new project — do not ask for a new conversation.',
    ].join(' ');

    await page.getByTestId('chat-composer').fill(prompt);
    await page.screenshot({ path: path.resolve(outputRoot, '02-prompt-ready.png') });
    await page.getByTestId('chat-send').click();
    await page.getByTestId('chat-streaming-message').waitFor({ timeout: 90_000 }).catch(() => null);

    const { lastAssistant, toolNamesSeen, modulesReady, failed, nudged } = await waitForDesignComplete(page, projectName);
    await sleep(2000);
    await ensureChatOpen(page);
    await page.screenshot({ path: path.resolve(outputRoot, '03-chat-after-design.png'), fullPage: true });
    await page.screenshot({ path: path.resolve(outputRoot, '04-workbench.png') });

    const transcriptAfterDesign = await page.getByTestId('chat-message-list').innerText().catch(() => '');
    const userPromptStillThere = transcriptAfterDesign.includes(projectName);
    const assistantBubbles = await page.locator('.chat-message-row--assistant').count();

    const sidebarBuck = page.locator(`[data-testid="sidebar-project-${projectName}"]`).first();
    if (await sidebarBuck.isVisible().catch(() => false)) {
      await sidebarBuck.click();
      await page.getByTestId('circuit-workbench').waitFor({ state: 'visible', timeout: 60_000 }).catch(() => undefined);
      await ensureChatOpen(page);
    }
    const workbenchProjectId = await page.locator('[data-testid="circuit-workbench"]')
      .getAttribute('data-project-id')
      .catch(() => null);

    const followUp = `In this same conversation for ${projectName}, confirm L and Cout only. Do not create a new project.`;
    await ensureChatOpen(page);
    await page.getByTestId('chat-composer').fill(followUp);
    await page.getByTestId('chat-send').click();
    await page.getByTestId('chat-streaming-message').waitFor({ timeout: 90_000 }).catch(() => null);

    const followDeadline = Date.now() + 5 * 60_000;
    while (Date.now() < followDeadline) {
      const streaming = await page.getByTestId('chat-streaming-message').count();
      const stopVisible = await page.getByTestId('chat-stop').isVisible().catch(() => false);
      const text = await assistantText(page);
      if (streaming === 0 && !stopVisible && /22|100|L1|Cout|µH|uH|uF/i.test(text)) break;
      await sleep(1500);
    }
    await sleep(1500);
    await page.screenshot({ path: path.resolve(outputRoot, '05-chat-followup.png'), fullPage: true });

    const transcriptFinal = await page.getByTestId('chat-message-list').innerText();
    const project = await readProjectIfExists(projectName);
    const historyPreserved =
      userPromptStillThere
      && transcriptFinal.includes(followUp.slice(0, 40))
      && transcriptFinal.includes(projectName)
      && assistantBubbles >= 1;

    const summary = {
      ok: Boolean(historyPreserved && modulesReady && !failed && project?.modules?.length >= 1),
      projectName,
      workbenchProjectId,
      revision: project?.revision ?? null,
      moduleIds: (project?.modules || []).map((m) => m.id),
      historyPreserved,
      userPromptStillThere,
      modulesReady,
      nudged: Boolean(nudged),
      assistantBubbles,
      followUpPresent: transcriptFinal.includes(followUp.slice(0, 40)),
      transcriptChars: transcriptFinal.length,
      pageErrors,
      consoleErrors: consoleErrors.slice(0, 40),
      toolNamesSeen,
      hasBuckMention: /buck|同步降压|降压/i.test(transcriptFinal),
      hasErrorLike: /Agent error:|Configure an API key|Chat error:/i.test(transcriptFinal),
      transcriptTail: transcriptFinal.slice(-6000),
      lastAssistantTail: String(lastAssistant || '').slice(-2500),
    };
    await writeFile(path.resolve(outputRoot, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
    await writeFile(path.resolve(outputRoot, 'transcript.txt'), transcriptFinal, 'utf8');
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
