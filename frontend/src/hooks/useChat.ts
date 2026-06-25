import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChartPayload, ChatStreamEvent } from '../types';

export type ChatBubble =
  | { kind: 'user'; content: string }
  | { kind: 'assistant-text'; content: string }
  | { kind: 'chart'; data: ChartPayload }
  | { kind: 'tool-status'; status: 'no-data' | 'insufficient'; message: string };

export function useChat() {
  const [bubbles, setBubbles] = useState<ChatBubble[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [sessionId] = useState(() => crypto.randomUUID());
  const esRef = useRef<EventSource | null>(null);

  const send = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || streaming) return;

      setBubbles((prev) => [
        ...prev,
        { kind: 'user', content: trimmed },
        { kind: 'assistant-text', content: '' },
      ]);
      setStreaming(true);

      const url = `/api/chat/stream?sessionId=${encodeURIComponent(sessionId)}&message=${encodeURIComponent(trimmed)}`;
      const es = new EventSource(url);
      esRef.current = es;

      const appendText = (delta: string) => {
        setBubbles((prev) => {
          const copy = [...prev];
          for (let i = copy.length - 1; i >= 0; i--) {
            const b = copy[i];
            if (b.kind === 'assistant-text') {
              copy[i] = { ...b, content: b.content + delta };
              return copy;
            }
            // Stop climbing once we hit a non-assistant bubble.
            if (b.kind === 'user' || b.kind === 'chart' || b.kind === 'tool-status') break;
          }
          return copy;
        });
      };

      const pushBubble = (b: ChatBubble) => {
        setBubbles((prev) => [...prev, b]);
      };

      es.onmessage = (ev) => {
        let payload: ChatStreamEvent;
        try {
          payload = JSON.parse(ev.data) as ChatStreamEvent;
        } catch {
          return;
        }
        switch (payload.type) {
          case 'text':
            appendText(payload.content);
            break;
          case 'chart':
            pushBubble({ kind: 'chart', data: payload.data });
            // Open a fresh assistant-text bubble for the summary that follows.
            pushBubble({ kind: 'assistant-text', content: '' });
            break;
          case 'analysis-summary':
            appendText(payload.content);
            break;
          case 'tool-status':
            pushBubble({
              kind: 'tool-status',
              status: payload.status,
              message: payload.message,
            });
            break;
          case 'done':
            es.close();
            esRef.current = null;
            setStreaming(false);
            // Trim a trailing empty assistant bubble (e.g., tool-status with no summary).
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
    [sessionId, streaming],
  );

  useEffect(() => {
    return () => {
      esRef.current?.close();
      esRef.current = null;
    };
  }, []);

  return { bubbles, send, streaming, sessionId };
}
