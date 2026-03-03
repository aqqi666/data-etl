import { create } from 'zustand';

export type ChatMode = 'etl' | 'metric';

interface ChatModeState {
  mode: ChatMode;
  setMode: (mode: ChatMode) => void;
}

export const useChatModeStore = create<ChatModeState>((set) => ({
  mode: 'etl',
  setMode: (mode) => set({ mode }),
}));
