import type { AnalysisSettings, LogEntry } from '../../lib/analyze';
import { analyzeLogs } from '../../lib/analyze';

type AnalyzeMessage = { type: 'analyze'; requestId: string; logs: LogEntry[]; settings: AnalysisSettings };
type CancelMessage = { type: 'cancel'; requestId: string };
type Incoming = AnalyzeMessage | CancelMessage;

type ProgressMessage = { type: 'progress'; requestId: string; stage: string; pct: number };
type ResultMessage = { type: 'result'; requestId: string; result: ReturnType<typeof analyzeLogs> };
type ErrorMessage = { type: 'error'; requestId: string; error: string };

let activeRequestId: string | null = null;

self.onmessage = (ev: MessageEvent<Incoming>) => {
  const msg = ev.data;
  if (msg.type === 'cancel') {
    if (activeRequestId === msg.requestId) activeRequestId = null;
    return;
  }

  if (msg.type === 'analyze') {
    activeRequestId = msg.requestId;
    try {
      const result = analyzeLogs({
        logs: msg.logs,
        settings: msg.settings,
        onProgress: (p) => {
          if (activeRequestId !== msg.requestId) return;
          (self as unknown as Worker).postMessage({ type: 'progress', requestId: msg.requestId, stage: p.stage, pct: p.pct } satisfies ProgressMessage);
        },
      });
      if (activeRequestId !== msg.requestId) return;
      (self as unknown as Worker).postMessage({ type: 'result', requestId: msg.requestId, result } satisfies ResultMessage);
    } catch (e) {
      if (activeRequestId !== msg.requestId) return;
      (self as unknown as Worker).postMessage({ type: 'error', requestId: msg.requestId, error: e instanceof Error ? e.message : 'Worker analysis failed' } satisfies ErrorMessage);
    }
  }
};

