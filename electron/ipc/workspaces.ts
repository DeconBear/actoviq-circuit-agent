import { BrowserWindow, IpcMain, dialog, shell, type OpenDialogOptions } from 'electron';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { loadSettings } from './settings.js';
import {
  createWorkspace,
  getActiveWorkspace,
  listReferenceDocuments,
  listWorkspaces,
  resolveReferenceDocument,
  selectWorkspace,
} from '../workspaceState.js';

function mimeTypeFor(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.pdf') return 'application/pdf';
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.tif' || ext === '.tiff') return 'image/tiff';
  if (ext === '.bmp') return 'image/bmp';
  return 'application/octet-stream';
}

function extractOcrText(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (!value || typeof value !== 'object') {
    return '';
  }

  const record = value as Record<string, unknown>;
  for (const key of ['text', 'ocr_text', 'ocrText', 'content']) {
    if (typeof record[key] === 'string') {
      return record[key] as string;
    }
  }
  for (const key of ['result', 'data']) {
    const nested = extractOcrText(record[key]);
    if (nested) {
      return nested;
    }
  }
  const pages = record.pages;
  if (Array.isArray(pages)) {
    return pages.map((page) => extractOcrText(page)).filter(Boolean).join('\n\n');
  }
  return '';
}

async function runYunzhishengOcr(relativePath: string): Promise<{ textPath: string; text: string }> {
  const settings = await loadSettings();
  const endpoint = settings.yunzhishengOcrBaseUrl.trim();
  if (!endpoint) {
    throw new Error('Configure Yunzhisheng OCR endpoint in Settings before running OCR.');
  }

  const { absolutePath, ocrPath } = await resolveReferenceDocument(relativePath);
  const fileBuffer = await readFile(absolutePath);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120_000);
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(settings.yunzhishengOcrApiKey.trim()
          ? { Authorization: `Bearer ${settings.yunzhishengOcrApiKey.trim()}` }
          : {}),
      },
      body: JSON.stringify({
        model: settings.yunzhishengOcrModel.trim() || undefined,
        file_name: path.basename(absolutePath),
        mime_type: mimeTypeFor(absolutePath),
        file_base64: fileBuffer.toString('base64'),
      }),
      signal: controller.signal,
    });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error('Yunzhisheng OCR request timed out after 120s.');
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    throw new Error(`Yunzhisheng OCR failed (${response.status}): ${errorText || response.statusText}`);
  }

  const responseText = await response.text();
  let payload: unknown;
  try {
    payload = JSON.parse(responseText);
  } catch {
    payload = { text: responseText };
  }
  const text = extractOcrText(payload).trim();
  if (!text) {
    throw new Error('Yunzhisheng OCR response did not contain recognizable text.');
  }

  await mkdir(path.dirname(ocrPath), { recursive: true });
  await writeFile(
    ocrPath,
    [
      '# OCR Result',
      '',
      `- Source: ${relativePath}`,
      `- Generated At: ${new Date().toISOString()}`,
      '',
      text,
      '',
    ].join('\n'),
    'utf8',
  );
  return { textPath: ocrPath, text };
}

export function registerWorkspaceHandlers(ipcMain: IpcMain): void {
  ipcMain.handle('workspace:list', async () => listWorkspaces());

  ipcMain.handle('workspace:active', async () => getActiveWorkspace());

  ipcMain.handle('workspace:create', async (_event, input: { name?: string; root?: string }) => {
    return createWorkspace(input ?? {});
  });

  ipcMain.handle('workspace:select', async (_event, id: string) => selectWorkspace(id));

  ipcMain.handle('workspace:choose-root', async () => {
    const win = BrowserWindow.getAllWindows()[0];
    const options: OpenDialogOptions = {
      title: 'Choose Workspace Root',
      properties: ['openDirectory', 'createDirectory'],
    };
    const result = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options);
    return result.canceled ? null : result.filePaths[0] ?? null;
  });

  ipcMain.handle('workspace:open-root', async () => {
    const workspace = await getActiveWorkspace();
    if (process.env.ACTOVIQ_E2E !== '1') {
      const error = await shell.openPath(workspace.root);
      if (error) throw new Error(error);
    }
    return workspace.root;
  });

  ipcMain.handle('workspace:open-references', async () => {
    const workspace = await getActiveWorkspace();
    await mkdir(workspace.referencesDir, { recursive: true });
    if (process.env.ACTOVIQ_E2E !== '1') {
      const error = await shell.openPath(workspace.referencesDir);
      if (error) throw new Error(error);
    }
    return workspace.referencesDir;
  });

  ipcMain.handle('workspace:list-references', async () => listReferenceDocuments());

  ipcMain.handle('workspace:ocr-reference', async (_event, relativePath: string) => {
    return runYunzhishengOcr(relativePath);
  });
}
