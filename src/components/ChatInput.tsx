import { useState, useRef, useEffect } from 'react';
import { SendHorizonal } from 'lucide-react';
import { useStore } from '../store';

export default function ChatInput() {
  const [text, setText] = useState('');
  const isProcessing = useStore(s => s.isProcessing);
  const sendMessage = useStore(s => s.sendMessage);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!isProcessing) inputRef.current?.focus();
  }, [isProcessing]);

  const handleSend = () => {
    const trimmed = text.trim();
    if (!trimmed || isProcessing) return;
    sendMessage(trimmed);
    setText('');
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="flex-shrink-0 border-t border-slate-200 bg-white">
      <div className="max-w-4xl mx-auto px-4 sm:px-6 py-3">
        <div className="flex items-end gap-3 bg-slate-50 rounded-xl border border-slate-200 p-2 focus-within:border-indigo-300 focus-within:ring-2 focus-within:ring-indigo-100 transition-all">
          <textarea
            ref={inputRef}
            value={text}
            onChange={e => setText(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder=""
            disabled={isProcessing}
            rows={1}
            className="flex-1 resize-none bg-transparent px-2 py-1.5 text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none disabled:opacity-50"
            style={{ maxHeight: 120, minHeight: 36 }}
            onInput={e => {
              const t = e.currentTarget;
              t.style.height = 'auto';
              t.style.height = Math.min(t.scrollHeight, 120) + 'px';
            }}
          />
          <button
            onClick={handleSend}
            disabled={isProcessing || !text.trim()}
            className={`
              p-2 rounded-lg transition-colors flex-shrink-0
              ${text.trim() && !isProcessing
                ? 'bg-indigo-600 text-white hover:bg-indigo-700 cursor-pointer'
                : 'bg-slate-200 text-slate-400 cursor-not-allowed'
              }
            `}
          >
            <SendHorizonal className="w-4 h-4" />
          </button>
        </div>
        <p className="text-xs text-slate-400 mt-1.5 text-center">
          Shift+Enter 换行 · Enter 发送
        </p>
      </div>
    </div>
  );
}
