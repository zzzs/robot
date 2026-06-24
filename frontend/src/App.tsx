import { useEffect, useRef, useState } from 'react';
import { useChat } from './hooks/useChat';
import './App.css';

function App() {
  const { messages, send, streaming, sessionId } = useChat();
  const [input, setInput] = useState('');
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [messages]);

  const submit = () => {
    if (!input.trim()) return;
    send(input);
    setInput('');
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div className="app">
      <header className="app-header">
        <h1>robot Chat</h1>
        <code className="session">session: {sessionId.slice(0, 8)}</code>
      </header>

      <div className="messages" ref={listRef}>
        {messages.length === 0 && (
          <div className="empty">说点什么开始对话吧(Enter 发送,Shift+Enter 换行)</div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`bubble ${m.role}`}>
            <span className="role">{m.role === 'user' ? '我' : 'AI'}</span>
            <div className="content">{m.content || (m.role === 'assistant' && streaming ? '…' : '')}</div>
          </div>
        ))}
      </div>

      <div className="input-bar">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={streaming ? 'AI 回答中…' : '输入消息'}
          disabled={streaming}
          rows={2}
        />
        <button onClick={submit} disabled={streaming || !input.trim()}>
          发送
        </button>
      </div>
    </div>
  );
}

export default App;
