import { create } from 'zustand';
import type { MetricDef } from './types';

const STORAGE_KEY = 'etl-metric-defs';

function loadAll(): MetricDef[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

function saveAll(defs: MetricDef[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(defs));
}

interface MetricDefState {
  defs: MetricDef[];
  add: (def: Omit<MetricDef, 'id' | 'createdAt'>) => MetricDef;
  remove: (id: string) => void;
  getAll: () => MetricDef[];
  getByDashboard: (dashboardId: string) => MetricDef[];
}

export const useMetricDefStore = create<MetricDefState>((set, get) => ({
  defs: loadAll(),

  add: (entry) => {
    const def: MetricDef = {
      ...entry,
      id: `md-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      createdAt: Date.now(),
    };
    const updated = [def, ...get().defs];
    saveAll(updated);
    set({ defs: updated });
    return def;
  },

  remove: (id) => {
    const updated = get().defs.filter(d => d.id !== id);
    saveAll(updated);
    set({ defs: updated });
  },

  getAll: () => get().defs,

  getByDashboard: (dashboardId) => get().defs.filter(d => d.dashboardId === dashboardId),
}));
