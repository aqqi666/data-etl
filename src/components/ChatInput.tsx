import { useState, useRef, useEffect } from 'react';
import { SendHorizonal, Wrench, BarChart3 } from 'lucide-react';
import { useStore } from '../store';
import { useMetricChatStore } from '../metricChatStore';
import { useChatModeStore } from '../chatModeStore';

export default function ChatInput() {
  const [text, setText] = useState('');
  const mode = useChatModeStore(s => s.mode);
  const setMode = useChatModeStore(s => s.setMode);

  const etlProcessing = useStore(s => s.isProcessing);
  const etlSend = useStore(s => s.sendMessage);
  const metricProcessing = useMetricChatStore(s => s.isProcessing);
  const metricSend = useMetricChatStore(s => s.sendMessage);

  const isProcessing = mode === 'etl' ? etlProcessing : metricProcessing;
  const sendMessage = mode === 'etl' ? etlSend : metricSend;

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

  const placeholder = mode === 'etl'
    ? '输入连接串或描述数据加工需求...'
    : '描述你想创建的指标...';

  return (
    <div className="flex-shrink-0 border-t border-slate-200 bg-white">
      <div className="max-w-4xl mx-auto px-4 sm:px-6 py-3">
        {/* Mode selector */}
        <div className="flex gap-1.5 mb-2">
          <button
            onClick={() => setMode('etl')}
            className={`flex items-center gap-1 px-2.5 py-1 text-[11px] font-medium rounded-md transition-colors cursor-pointer ${
              mode === 'etl'
                ? 'bg-indigo-50 text-indigo-700 border border-indigo-200'
                : 'text-slate-400 hover:text-slate-600 hover:bg-slate-50 border border-transparent'
            }`}
          >
            <Wrench className="w-3 h-3" />
            业务表加工
          </button>
          <button
            onClick={() => setMode('metric')}
            className={`flex items-center gap-1 px-2.5 py-1 text-[11px] font-medium rounded-md transition-colors cursor-pointer ${
              mode === 'metric'
                ? 'bg-indigo-50 text-indigo-700 border border-indigo-200'
                : 'text-slate-400 hover:text-slate-600 hover:bg-slate-50 border border-transparent'
            }`}
          >
            <BarChart3 className="w-3 h-3" />
            添加指标
          </button>
        </div>

        {/* Input area */}
        <div className="flex items-end gap-3 bg-slate-50 rounded-xl border border-slate-200 p-2 focus-within:border-indigo-300 focus-within:ring-2 focus-within:ring-indigo-100 transition-all">
          <textarea
            ref={inputRef}
            value={text}
            onChange={e => setText(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={placeholder}
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
