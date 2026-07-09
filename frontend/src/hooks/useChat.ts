import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChartPayload, ChatStreamEvent } from '../types';

export type ChatBubble =
  | { kind: 'user'; content: string }
  | { kind: 'assistant-text'; content: string }
  | { kind: 'chart'; data: ChartPayload }
  | { kind: 'tool-status'; status: 'no-data' | 'insufficient'; message: string }
  | { kind: 'confirm'; reason: string; confirmLabel: string; cancelLabel: string };

export function useChat() {
  const [bubbles, setBubbles] = useState<ChatBubble[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [awaitingConfirm, setAwaitingConfirm] = useState(false);
  const [sessionId] = useState(() => crypto.randomUUID());
  const esRef = useRef<EventSource | null>(null);

  const handleEventSource = useCallback(
    (es: EventSource) => {
      es.onmessage = (ev: MessageEvent) => {
        let payload: ChatStreamEvent;
        try {
          payload = JSON.parse(ev.data) as ChatStreamEvent;
        } catch {
          return;
        }
        switch (payload.type) {
          case 'text':
            setBubbles((prev) => {
              const copy = [...prev];
              for (let i = copy.length - 1; i >= 0; i--) {
                const b = copy[i];
                if (b.kind === 'assistant-text') {
                  copy[i] = { ...b, content: b.content + payload.content };
                  return copy;
                }
                if (b.kind === 'user' || b.kind === 'chart' || b.kind === 'tool-status' || b.kind === 'confirm') break;
              }
              return copy;
            });
            break;
          case 'chart':
            setBubbles((prev) => [
              ...prev,
              { kind: 'chart' as const, data: payload.data },
              { kind: 'assistant-text' as const, content: '' },
            ]);
            break;
          case 'analysis-summary':
            setBubbles((prev) => {
              const copy = [...prev];
              for (let i = copy.length - 1; i >= 0; i--) {
                const b = copy[i];
                if (b.kind === 'assistant-text') {
                  copy[i] = { ...b, content: b.content + payload.content };
                  return copy;
                }
                if (b.kind === 'user' || b.kind === 'chart' || b.kind === 'tool-status' || b.kind === 'confirm') break;
              }
              return copy;
            });
            break;
          case 'tool-status':
            setBubbles((prev) => [
              ...prev,
              {
                kind: 'tool-status' as const,
                status: payload.status,
                message: payload.message,
              },
            ]);
            break;
          case 'interrupt':
            setBubbles((prev) => [
              ...prev,
              {
                kind: 'confirm' as const,
                reason: payload.reason,
                confirmLabel: payload.confirmLabel,
                cancelLabel: payload.cancelLabel,
              },
            ]);
            setAwaitingConfirm(true);
            es.close();
            esRef.current = null;
            setStreaming(false);
            break;
          case 'done':
            es.close();
            esRef.current = null;
            setStreaming(false);
            setBubbles((prev) => {
              if (prev.length === 0) return prev;
              const last = prev[prev.length - 1];
              if (last.kind === 'assistant-text' && last.content === '') {
                return prev.slice(0, -1);
              }
              return prev;
            });
            break;
        }
      };

      es.onerror = () => {
        es.close();
        esRef.current = null;
        setStreaming(false);
      };
    },
    [],
  );

  const send = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || streaming || awaitingConfirm) return;

      setBubbles((prev) => [
        ...prev,
        { kind: 'user' as const, content: trimmed },
        { kind: 'assistant-text' as const, content: '' },
      ]);
      setStreaming(true);

      const url = `/api/chat/stream?sessionId=${encodeURIComponent(sessionId)}&message=${encodeURIComponent(trimmed)}`;
      const es = new EventSource(url);
      esRef.current = es;
      handleEventSource(es);
    },
    [sessionId, streaming, awaitingConfirm, handleEventSource],
  );

  const resume = useCallback(
    (action: 'confirm' | 'cancel') => {
      if (!awaitingConfirm) return;

      setStreaming(true);
      setAwaitingConfirm(false);

      // Remove the confirm bubble (it's been acted on)
      setBubbles((prev) => {
        const last = prev[prev.length - 1];
        if (last?.kind === 'confirm') {
          return prev.slice(0, -1);
        }
        return prev;
      });

      if (action === 'cancel') {
        setBubbles((prev) => [
          ...prev,
          { kind: 'assistant-text' as const, content: '已取消,未展示分析结果。' },
        ]);
        setStreaming(false);
        return;
      }

      // confirm: open SSE to resume endpoint, add fresh assistant-text bubble
      setBubbles((prev) => [...prev, { kind: 'assistant-text' as const, content: '' }]);
      const url = `/api/chat/resume?sessionId=${encodeURIComponent(sessionId)}&action=confirm`;
      const es = new EventSource(url);
      esRef.current = es;
      handleEventSource(es);
    },
    [sessionId, awaitingConfirm, handleEventSource],
  );

  useEffect(() => {
    return () => {
      esRef.current?.close();
      esRef.current = null;
    };
  }, []);

  return { bubbles, send, streaming, sessionId, awaitingConfirm, resume };
}
