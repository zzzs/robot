import { useEffect, useRef, useState } from 'react';
import { useChat } from './hooks/useChat';
import { StockChart } from './components/StockChart';
import './App.css';

function App() {
  const { bubbles, send, streaming, sessionId } = useChat();
  const [input, setInput] = useState('');
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [bubbles]);

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
        {bubbles.length === 0 && (
          <div className="empty">说点什么开始对话吧 (Enter 发送, Shift+Enter 换行)</div>
        )}
        {bubbles.map((b, i) => {
          if (b.kind === 'user') {
            return (
              <div key={i} className="bubble user">
                <span className="role">我</span>
                <div className="content">{b.content}</div>
              </div>
            );
          }
          if (b.kind === 'chart') {
            return (
              <div key={i} className="bubble assistant chart">
                <span className="role">图表 · {b.data.symbol}</span>
                <div className="chart-wrap">
                  <StockChart data={b.data} />
                </div>
              </div>
            );
          }
          if (b.kind === 'tool-status') {
            return (
              <div key={i} className="bubble assistant tool-status">
                <span className="role">提示</span>
                <div className="content tool-status-content">{b.message}</div>
              </div>
            );
          }
          // assistant-text
          return (
            <div key={i} className="bubble assistant">
              <span className="role">AI</span>
              <div className="content">
                {b.content || (streaming ? '…' : '')}
              </div>
            </div>
          );
        })}
      </div>

      <div className="input-bar">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={streaming ? 'AI 回答中…' : '输入消息 (试试 "分析一下 600519.SH")'}
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
