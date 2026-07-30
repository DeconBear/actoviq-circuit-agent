import type { CircuitModule } from '../../types';
import {
  deserializeSchematicDocument,
  type SchematicDocument,
  type SchematicDocumentOptions,
  type SerializableSchematicDocument,
} from '../../schematic/schematicDocument';
import type { InteractiveProjectionQuality } from './interactiveQuality';
import type { SchematicProjectionMode } from './facade';

export interface ProjectionWorkerLike {
  postMessage(value: unknown): void;
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  removeEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  terminate?(): void;
}

interface PendingProjection {
  resolve: (result: ProjectionWorkerResult) => void;
  reject: (error: Error) => void;
  abort?: () => void;
}

export interface ProjectionWorkerResult {
  document: SchematicDocument;
  quality: InteractiveProjectionQuality;
  mode: SchematicProjectionMode;
  affectedEntities: string[];
  reused: {
    geometry: boolean;
    routing: boolean;
    bounds: boolean;
  };
}

export class ProjectionWorkerClient {
  private nextRequestId = 1;
  private pending = new Map<number, PendingProjection>();
  private readonly onMessage = (event: MessageEvent) => {
    const message = event.data as {
      type?: string;
      requestId?: number;
      artifact?: SerializableSchematicDocument;
      quality?: InteractiveProjectionQuality;
      mode?: SchematicProjectionMode;
      affectedEntities?: string[];
      reused?: ProjectionWorkerResult['reused'];
      error?: string;
    };
    const requestId = Number(message.requestId);
    const pending = this.pending.get(requestId);
    if (!pending) return;
    this.pending.delete(requestId);
    pending.abort?.();
    if (message.type === 'result' && message.artifact && message.quality) {
      pending.resolve({
        document: deserializeSchematicDocument(message.artifact),
        quality: message.quality,
        mode: message.mode ?? 'full',
        affectedEntities: message.affectedEntities ?? [],
        reused: message.reused ?? { geometry: false, routing: false, bounds: false },
      });
    } else {
      pending.reject(new Error(message.error || 'Schematic projection worker failed'));
    }
  };

  constructor(private readonly worker: ProjectionWorkerLike) {
    worker.addEventListener('message', this.onMessage);
  }

  project(
    module: CircuitModule,
    options: SchematicDocumentOptions = {},
    signal?: AbortSignal,
  ): Promise<ProjectionWorkerResult> {
    const requestId = this.nextRequestId;
    this.nextRequestId += 1;
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new DOMException('Projection cancelled', 'AbortError'));
        return;
      }
      const cancel = () => {
        if (!this.pending.delete(requestId)) return;
        reject(new DOMException('Projection cancelled', 'AbortError'));
      };
      signal?.addEventListener('abort', cancel, { once: true });
      this.pending.set(requestId, {
        resolve,
        reject,
        abort: signal ? () => signal.removeEventListener('abort', cancel) : undefined,
      });
      this.worker.postMessage({ type: 'project', requestId, module, options });
    });
  }

  dispose(): void {
    this.worker.removeEventListener('message', this.onMessage);
    for (const pending of this.pending.values()) {
      pending.reject(new DOMException('Projection worker disposed', 'AbortError'));
    }
    this.pending.clear();
    this.worker.terminate?.();
  }
}

let sharedClient: ProjectionWorkerClient | null = null;

export function sharedProjectionWorker(): ProjectionWorkerClient {
  if (!sharedClient) {
    sharedClient = new ProjectionWorkerClient(
      new Worker(new URL('./projection.worker.ts', import.meta.url), { type: 'module' }),
    );
  }
  return sharedClient;
}
