import { IpcMain } from 'electron';
import {
  startDesktopAgentRun,
  type DesktopAgentChatResponse,
  type DesktopAgentRunHandle,
} from '../agent/desktopAgentService.js';
import { summarizeOlderChatTurns } from '../agent/chatHistorySummarize.js';
import {
  contextLimitForTier,
  prepareChatHistory,
  resolveTierContext1M,
  resolveTierModel,
  type ChatModelTier,
} from '../agent/modelTiers.js';
import { loadSettingsWithSecrets } from './settings.js';

interface ChatContext {
  conversationId?: string;
  activeJobId?: string | null;
  activeProject?: Record<string, unknown> | null;
  workspaceRoot?: string;
  modelTier?: ChatModelTier;
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

function normalizeTier(value: unknown): ChatModelTier {
  return value === 'basic' || value === 'professional' ? value : 'medium';
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
    if (!settings.actoviqBaseUrl) {
      return configurationError('Provider URL is required. Check Settings.');
    }

    const tier = normalizeTier(context?.modelTier ?? settings.preferredChatTier);
    const model = resolveTierModel(settings, tier);
    if (!model) {
      return configurationError('Configure Basic / Medium / Professional models in Settings before chatting.');
    }
    const supports1M = resolveTierContext1M(settings, tier);
    const contextLimit = contextLimitForTier(supports1M);
    const basicModel = settings.basicModel.trim() || settings.haikuModel.trim() || model;
    const workDir = context?.workspaceRoot || settings.workspaceRoot || process.cwd();
    const prepared = await prepareChatHistory({
      history: history ?? [],
      currentMessage: trimmed,
      maxTokens: contextLimit,
      summarizeOlder: (older) => summarizeOlderChatTurns(
        {
          provider: settings.actoviqProvider,
          apiKey: settings.actoviqAuthToken,
          baseURL: settings.actoviqBaseUrl,
          model: basicModel,
          workDir,
        },
        older,
      ),
    });

    const conversationId = context?.conversationId?.trim()
      || `desktop-${event.sender.id}-${Date.now()}`;
    const key = runKey(event.sender.id, conversationId);
    activeRuns.get(key)?.cancel('Superseded by a newer request');

    const handle = startDesktopAgentRun(
      {
        provider: settings.actoviqProvider,
        apiKey: settings.actoviqAuthToken,
        baseURL: settings.actoviqBaseUrl,
        model,
        workDir,
      },
      {
        conversationId,
        message: trimmed,
        history: prepared.history,
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
      const result = await handle.result;
      if (prepared.compressed && !result.isError) {
        const modeLabel = prepared.mode === 'summarized' ? 'auto-summarized' : 'auto-compressed';
        return {
          ...result,
          text: `${result.text}\n\n_Context ${modeLabel} to fit the ${contextLimit.toLocaleString()}-token ${supports1M ? '1M' : '200K'} window._`,
        };
      }
      return result;
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
