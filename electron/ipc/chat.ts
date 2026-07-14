import { IpcMain } from 'electron';
import {
  startDesktopAgentRun,
  type DesktopAgentChatResponse,
  type DesktopAgentRunHandle,
} from '../agent/desktopAgentService.js';
import { loadSettingsWithSecrets } from './settings.js';

interface ChatContext {
  conversationId?: string;
  activeJobId?: string | null;
  activeProject?: Record<string, unknown> | null;
  workspaceRoot?: string;
}

const activeRuns = new Map<string, DesktopAgentRunHandle>();

function runKey(webContentsId: number, conversationId: string): string {
  return `${webContentsId}:${conversationId}`;
}

function configurationError(text: string): DesktopAgentChatResponse {
  return {
    text,
    isDesignRequest: false,
    isRevisionRequest: false,
    isError: true,
  };
}

export function registerChatHandlers(ipcMain: IpcMain): void {
  ipcMain.handle('chat:send', async (
    event,
    message: string,
    history?: Array<{ role: 'user' | 'assistant'; content: string }>,
    context?: ChatContext,
  ): Promise<DesktopAgentChatResponse> => {
    const trimmed = typeof message === 'string' ? message.trim() : '';
    if (!trimmed) return configurationError('Enter a message before sending.');

    const settings = await loadSettingsWithSecrets();
    if (!settings.actoviqAuthToken) {
      return configurationError('Configure an API key in Settings before chatting.');
    }
    if (!settings.actoviqBaseUrl || !settings.chatModel) {
      return configurationError('Provider URL and chat model are required. Check Settings.');
    }

    const conversationId = context?.conversationId?.trim()
      || `desktop-${event.sender.id}-${Date.now()}`;
    const key = runKey(event.sender.id, conversationId);
    activeRuns.get(key)?.cancel('Superseded by a newer request');

    const handle = startDesktopAgentRun(
      {
        provider: settings.actoviqProvider,
        apiKey: settings.actoviqAuthToken,
        baseURL: settings.actoviqBaseUrl,
        model: settings.chatModel,
        workDir: context?.workspaceRoot || settings.workspaceRoot || process.cwd(),
      },
      {
        conversationId,
        message: trimmed,
        history,
        context: {
          activeJobId: context?.activeJobId,
          activeProject: context?.activeProject,
        },
      },
      (agentEvent) => {
        if (!event.sender.isDestroyed()) event.sender.send('chat:event', agentEvent);
      },
    );
    activeRuns.set(key, handle);
    try {
      return await handle.result;
    } finally {
      if (activeRuns.get(key) === handle) activeRuns.delete(key);
    }
  });

  ipcMain.handle('chat:stop', async (event, conversationId?: string): Promise<boolean> => {
    let stopped = false;
    if (conversationId) {
      const key = runKey(event.sender.id, conversationId);
      const handle = activeRuns.get(key);
      if (handle) {
        handle.cancel('Stopped by user');
        activeRuns.delete(key);
        stopped = true;
      }
      return stopped;
    }

    const prefix = `${event.sender.id}:`;
    for (const [key, handle] of activeRuns) {
      if (!key.startsWith(prefix)) continue;
      handle.cancel('Stopped by user');
      activeRuns.delete(key);
      stopped = true;
    }
    return stopped;
  });
}
