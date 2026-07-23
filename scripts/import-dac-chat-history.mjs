/**
 * Import the live DeepSeek 8-bit DAC chat transcript into the desktop app's
 * per-project chat history (localStorage v2), scoped to project 8-bit-r2r-dac.
 *
 * Run while Vite is up on 5173 (electron:dev). Temporarily owns the Electron window.
 *
 *   node scripts/import-dac-chat-history.mjs
 */
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const projectId = '8-bit-r2r-dac';
const conversationId = 'conv-1784799770791-owgf5h';
const transcriptPath = path.resolve(
  root,
  'output',
  'playwright',
  'live-dac-1784799766108',
  'transcript.txt',
);
const storageKey = 'actoviq.desktop.chat-history.v2';
const userDataDir = process.env.APPDATA
  ? path.join(process.env.APPDATA, 'actoviq-circuit-agent')
  : path.resolve(root, 'output', 'playwright', 'import-chat-user-data');
const viteUrl = process.env.ACTOVIQ_RENDERER_URL || 'http://127.0.0.1:5173';
const electronDistDir = path.resolve(root, 'node_modules', 'electron', 'dist');
const outDir = path.resolve(root, 'output', 'playwright', `import-dac-chat-${Date.now()}`);

function parseTranscript(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  /** @type {Array<{ role: 'user' | 'assistant' | 'system'; content: string; stamp?: string }>} */
  const blocks = [];
  let role = null;
  let stamp = '';
  let buf = [];

  const flush = () => {
    if (!role) return;
    const content = buf.join('\n').trim();
    if (content) blocks.push({ role, content, stamp });
    role = null;
    stamp = '';
    buf = [];
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line === 'You' && /^\d{1,2}:\d{2}$/.test(lines[i + 1] || '')) {
      flush();
      role = 'user';
      stamp = lines[i + 1];
      i += 1;
      continue;
    }
    if (line === 'Actoviq' && /^\d{1,2}:\d{2}$/.test(lines[i + 1] || '')) {
      flush();
      role = 'assistant';
      stamp = lines[i + 1];
      i += 1;
      continue;
    }
    if (role) buf.push(line);
  }
  flush();
  return blocks;
}

function stampToTs(stamp, fallback) {
  // transcript is wall-clock HH:MM from the live run day; use live-dac epoch base.
  const base = 1784799770791;
  if (!stamp || !/^\d{1,2}:\d{2}$/.test(stamp)) return fallback;
  const [hh, mm] = stamp.split(':').map(Number);
  const d = new Date(base);
  d.setHours(hh, mm, 0, 0);
  return d.getTime();
}

function buildConversation(blocks) {
  const messages = blocks.map((block, index) => {
    const ts = stampToTs(block.stamp, 1784799770791 + index * 1000);
    return {
      id: `${block.role}-${conversationId}-${index}`,
      role: block.role,
      content: block.content,
      timestamp: ts,
      conversationId,
      ...(block.role === 'assistant' && index === 1
        ? { model: 'deepseek-chat' }
        : {}),
    };
  });

  const last = messages[messages.length - 1];
  const firstUser = messages.find((entry) => entry.role === 'user');
  const summary = {
    id: conversationId,
    title: (firstUser?.content || '8-bit R-2R DAC').slice(0, 80),
    lastMessage: last?.content || '',
    messageCount: messages.length,
    updatedAt: last?.timestamp || Date.now(),
    titleLocked: true,
    projectId,
  };

  return { summary, messages };
}

async function waitForUrl(url, timeoutMs = 30_000) {
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
  await mkdir(outDir, { recursive: true });
  const transcript = await readFile(transcriptPath, 'utf8');
  const blocks = parseTranscript(transcript);
  if (blocks.length === 0) {
    throw new Error(`No chat blocks parsed from ${transcriptPath}`);
  }
  const { summary, messages } = buildConversation(blocks);
  await writeFile(
    path.join(outDir, 'import-payload.json'),
    `${JSON.stringify({ summary, messages }, null, 2)}\n`,
    'utf8',
  );

  await waitForUrl(viteUrl);

  const electronApp = await electron.launch({
    args: [`--user-data-dir=${userDataDir}`, '.'],
    cwd: root,
    env: {
      ...process.env,
      ACTOVIQ_RENDERER_URL: viteUrl,
      ELECTRON_ENABLE_LOGGING: '1',
      PATH: `${electronDistDir}${path.delimiter}${process.env.PATH ?? ''}`,
    },
  });

  try {
    const page = await electronApp.firstWindow();
    page.setDefaultTimeout(60_000);
    await page.waitForSelector('[data-testid="circuit-workbench"]', { timeout: 60_000 });

    const result = await page.evaluate(({ storageKey: key, summary: nextSummary, messages: nextMessages, projectId: pid, conversationId: cid }) => {
      const raw = localStorage.getItem(key);
      let snapshot = {
        version: 2,
        conversationId: cid,
        conversations: [],
        conversationMessages: {},
        activeConversationByProject: {},
        savedAt: Date.now(),
      };
      if (raw) {
        try {
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed === 'object') {
            snapshot = {
              version: 2,
              conversationId: typeof parsed.conversationId === 'string' ? parsed.conversationId : cid,
              conversations: Array.isArray(parsed.conversations) ? parsed.conversations : [],
              conversationMessages: parsed.conversationMessages && typeof parsed.conversationMessages === 'object'
                ? parsed.conversationMessages
                : {},
              activeConversationByProject: parsed.activeConversationByProject && typeof parsed.activeConversationByProject === 'object'
                ? parsed.activeConversationByProject
                : {},
              savedAt: Date.now(),
            };
          }
        } catch {
          // replace corrupt snapshot
        }
      }

      const conversations = [
        nextSummary,
        ...snapshot.conversations.filter((entry) => entry && entry.id !== nextSummary.id),
      ].slice(0, 50);
      const conversationMessages = {
        ...snapshot.conversationMessages,
        [cid]: nextMessages,
      };
      const activeConversationByProject = {
        ...snapshot.activeConversationByProject,
        [pid]: cid,
      };
      const next = {
        version: 2,
        conversationId: cid,
        conversations,
        conversationMessages,
        activeConversationByProject,
        savedAt: Date.now(),
      };
      localStorage.setItem(key, JSON.stringify(next));
      return {
        ok: true,
        conversationCount: conversations.length,
        messageCount: nextMessages.length,
        activeForProject: activeConversationByProject[pid],
      };
    }, {
      storageKey,
      summary,
      messages,
      projectId,
      conversationId,
    });

    // Force renderer store hydrate path by reloading after write.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-testid="circuit-workbench"]', { timeout: 60_000 });

    // Open the DAC project if present, then open chat so History can show it.
    const opened = await page.evaluate(async (pid) => {
      if (!window.electronAPI?.listCircuitProjects || !window.electronAPI?.getCircuitProject) {
        return { opened: false, reason: 'no-api' };
      }
      const projects = await window.electronAPI.listCircuitProjects();
      const hit = projects.find((entry) => entry.projectId === pid);
      if (!hit) return { opened: false, reason: 'project-missing', projects: projects.map((p) => p.projectId) };
      // Click sidebar item when available.
      return { opened: true, projectId: pid };
    }, projectId);

    const projectButton = page.getByTestId(`sidebar-project-${projectId}`);
    if (await projectButton.count()) {
      await projectButton.click();
      await page.waitForTimeout(800);
    }

    const composerVisible = await page.getByTestId('chat-composer').isVisible().catch(() => false);
    if (!composerVisible) {
      await page.getByTestId('topbar-chat').click().catch(() => undefined);
      await page.getByTestId('chat-composer').waitFor({ state: 'visible', timeout: 15_000 }).catch(() => undefined);
    }

    await page.getByTestId('chat-history-toggle').click().catch(() => undefined);
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(outDir, 'history-after-import.png'), fullPage: true });

    const verify = await page.evaluate(({ storageKey: key, cid, pid }) => {
      const raw = localStorage.getItem(key);
      const parsed = raw ? JSON.parse(raw) : null;
      const messages = parsed?.conversationMessages?.[cid] || [];
      return {
        hasKey: Boolean(raw),
        activeConversationByProject: parsed?.activeConversationByProject || {},
        conversationIds: (parsed?.conversations || []).map((entry) => entry.id),
        projectIds: (parsed?.conversations || []).map((entry) => entry.projectId),
        importedMessageCount: messages.length,
        importedTitle: (parsed?.conversations || []).find((entry) => entry.id === cid)?.title || null,
        activeForProject: parsed?.activeConversationByProject?.[pid] || null,
      };
    }, { storageKey, cid: conversationId, pid: projectId });

    await writeFile(path.join(outDir, 'result.json'), `${JSON.stringify({ result, opened, verify }, null, 2)}\n`, 'utf8');
    console.log(JSON.stringify({ outDir, result, opened, verify }, null, 2));
  } finally {
    try { await electronApp.close(); } catch { /* ignore */ }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
