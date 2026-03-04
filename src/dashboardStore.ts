import { create } from 'zustand';
import type { Dashboard } from './types';
import { useProcessedTableStore } from './processedTableStore';

const STORAGE_KEY = 'etl-dashboards';

function loadDashboards(): Dashboard[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveDashboards(dashboards: Dashboard[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(dashboards));
}

interface DashboardState {
  dashboards: Dashboard[];
  activeDashboardId: string | null;

  createDashboard: (name: string, description: string) => string;
  deleteDashboard: (id: string) => void;
  renameDashboard: (id: string, name: string) => void;
  openDashboard: (id: string) => void;
  goHome: () => void;
}

export const useDashboardStore = create<DashboardState>((set, get) => ({
  dashboards: loadDashboards(),
  activeDashboardId: null,

  createDashboard: (name, description) => {
    const id = `db-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const now = Date.now();
    const dashboard: Dashboard = { id, name, description, createdAt: now, updatedAt: now };
    const updated = [dashboard, ...get().dashboards];
    saveDashboards(updated);
    set({ dashboards: updated, activeDashboardId: id });
    return id;
  },

  deleteDashboard: (id) => {
    const updated = get().dashboards.filter(d => d.id !== id);
    saveDashboards(updated);
    // 清理该 dashboard 的聊天记录
    localStorage.removeItem(`etl-chat-${id}`);
    localStorage.removeItem(`etl-unified-chat-${id}`);
    localStorage.removeItem(`etl-metric-chat-${id}`);
    // 清理该 dashboard 的已加工表记录
    useProcessedTableStore.getState().clearByDashboard(id);
    set({ dashboards: updated });
  },

  renameDashboard: (id, name) => {
    const updated = get().dashboards.map(d =>
      d.id === id ? { ...d, name, updatedAt: Date.now() } : d
    );
    saveDashboards(updated);
    set({ dashboards: updated });
  },

  openDashboard: (id) => {
    set({ activeDashboardId: id });
  },

  goHome: () => {
    set({ activeDashboardId: null });
  },
}));
