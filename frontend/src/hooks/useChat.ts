import { useCallback, useEffect, useRef, useState } from 'react';

export interface Msg {
  role: 'user' | 'assistant';
  content: string;
}

interface StreamPayload {
  content?: string;
  done?: boolean;
}

export function useChat() {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [sessionId] = useState(() => crypto.randomUUID());
  const esRef = useRef<EventSource | null>(null);

  const send = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || streaming) return;

      setMessages((prev) => [
        ...prev,
        { role: 'user', content: trimmed },
        { role: 'assistant', content: '' },
      ]);
      setStreaming(true);

      const url = `/api/chat/stream?sessionId=${encodeURIComponent(sessionId)}&message=${encodeURIComponent(trimmed)}`;
      const es = new EventSource(url);
      esRef.current = es;

      es.onmessage = (ev) => {
        let payload: StreamPayload;
        try {
          payload = JSON.parse(ev.data) as StreamPayload;
        } catch {
          return;
        }
        if (payload.done) {
          es.close();
          esRef.current = null;
          setStreaming(false);
          return;
        }
        if (payload.content !== undefined) {
          setMessages((prev) => {
            const copy = [...prev];
            const last = copy[copy.length - 1];
            if (last && last.role === 'assistant') {
              copy[copy.length - 1] = {
                ...last,
                content: last.content + payload.content!,
              };
            }
            return copy;
          });
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

  return { messages, send, streaming, sessionId };
}
