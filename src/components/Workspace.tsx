import { useEffect, useRef } from 'react';
import { Database } from 'lucide-react';
import { useStore } from '../store';
import { ETL_STEP_LABELS, ETL_STEP_DESC, type EtlStep } from '../types';
import ChatMessage from './ChatMessage';
import ChatInput from './ChatInput';

function TypingIndicator() {
  return (
    <div className="flex gap-3 msg-enter px-4 sm:px-0">
      <div className="w-8 h-8 rounded-full bg-gradient-to-br from-indigo-500 to-indigo-600 flex items-center justify-center flex-shrink-0 mt-1">
        <Database className="w-4 h-4 text-white" />
      </div>
      <div className="bg-white border border-slate-200 rounded-2xl rounded-tl-sm px-5 py-3.5 shadow-sm">
        <div className="flex gap-1.5 items-center h-5">
          <div className="w-2 h-2 rounded-full bg-indigo-400 typing-dot" />
          <div className="w-2 h-2 rounded-full bg-indigo-400 typing-dot" />
          <div className="w-2 h-2 rounded-full bg-indigo-400 typing-dot" />
        </div>
      </div>
    </div>
  );
}

function StepProgress({ current }: { current: EtlStep }) {
  const steps = ([1, 2, 3, 4, 5, 6] as const);

  return (
    <div className="w-full">
      <div className="flex items-center">
        {steps.map((n, i) => (
          <div key={n} className="flex items-center flex-1 last:flex-none">
            <div className="flex flex-col items-center">
              <div
                className={`
                  w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold border-2 transition-all
                  ${n === current
                    ? 'bg-indigo-600 border-indigo-600 text-white shadow-md shadow-indigo-200'
                    : n < current
                    ? 'bg-indigo-100 border-indigo-300 text-indigo-600'
                    : 'bg-white border-slate-200 text-slate-400'
                  }
                `}
              >
                {n < current ? '✓' : n}
              </div>
              <span
                className={`mt-1 text-[10px] whitespace-nowrap leading-tight text-center
                  ${n === current ? 'text-indigo-700 font-semibold' : n < current ? 'text-indigo-400' : 'text-slate-400'}
                `}
              >
                {ETL_STEP_LABELS[n]}
              </span>
            </div>
            {i < steps.length - 1 && (
              <div className="flex-1 h-0.5 mx-1 mb-4 rounded-full transition-all duration-300" style={{
                background: n < current ? '#a5b4fc' : '#e2e8f0',
              }} />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

export default function Workspace() {
  const step = useStore(s => s.step);
  const messages = useStore(s => s.messages);
  const isProcessing = useStore(s => s.isProcessing);
  const reset = useStore(s => s.reset);
  const chatEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isProcessing]);

  return (
    <div className="h-screen flex flex-col bg-gradient-to-b from-slate-50 to-white">
      {/* 顶部 Header */}
      <header className="flex-shrink-0 border-b border-slate-200 bg-white/80 backdrop-blur-sm">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 pt-3 pb-2 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-indigo-500 to-indigo-600 flex items-center justify-center">
              <Database className="w-3.5 h-3.5 text-white" />
            </div>
            <span className="text-sm font-semibold text-slate-900">智能数据 ETL 助手</span>
          </div>
          <button onClick={reset} className="text-xs text-slate-400 hover:text-slate-600 cursor-pointer transition-colors">
            新建会话
          </button>
        </div>
        {/* 进度条 */}
        <div className="max-w-4xl mx-auto px-4 sm:px-6 pb-4 overflow-x-auto">
          <StepProgress current={step} />
        </div>
      </header>

      {/* 当前步骤说明条 */}
      <div className="flex-shrink-0 bg-indigo-50 border-b border-indigo-100 px-4 sm:px-6 py-2">
        <div className="max-w-4xl mx-auto flex items-center gap-2">
          <span className="text-xs font-semibold text-indigo-700 bg-indigo-100 rounded px-2 py-0.5 whitespace-nowrap">
            第 {step} 步
          </span>
          <span className="text-xs text-indigo-600 truncate">{ETL_STEP_DESC[step]}</span>
        </div>
      </div>

      {/* 对话主区 */}
      <main className="flex-1 overflow-y-auto">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 py-6 space-y-5">
          {messages.map(msg => (
            <ChatMessage key={msg.id} message={msg} />
          ))}
          {isProcessing && <TypingIndicator />}
          <div ref={chatEndRef} />
        </div>
      </main>

      <ChatInput />
    </div>
  );
}
