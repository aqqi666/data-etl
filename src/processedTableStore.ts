import { create } from 'zustand';
import type { ProcessedTable } from './types';

const STORAGE_KEY = 'etl-processed-tables';

function loadAll(): ProcessedTable[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

function saveAll(tables: ProcessedTable[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(tables));
}

interface ProcessedTableState {
  tables: ProcessedTable[];
  getByDashboard: (dashboardId: string) => ProcessedTable[];
  addOrUpdate: (entry: Omit<ProcessedTable, 'id'>) => void;
  remove: (id: string) => void;
  clearByDashboard: (dashboardId: string) => void;
}

export const useProcessedTableStore = create<ProcessedTableState>((set, get) => ({
  tables: loadAll(),

  getByDashboard: (dashboardId) =>
    get().tables.filter(t => t.dashboardId === dashboardId),

  addOrUpdate: (entry) => {
    const id = `${entry.database}.${entry.table}`;
    const existing = get().tables;
    const idx = existing.findIndex(t => t.id === id && t.dashboardId === entry.dashboardId);
    let updated: ProcessedTable[];
    if (idx >= 0) {
      updated = [...existing];
      updated[idx] = { ...updated[idx], ...entry, id, processedAt: Date.now() };
    } else {
      updated = [{ ...entry, id, processedAt: Date.now() }, ...existing];
    }
    saveAll(updated);
    set({ tables: updated });
  },

  remove: (id) => {
    const updated = get().tables.filter(t => t.id !== id);
    saveAll(updated);
    set({ tables: updated });
  },

  clearByDashboard: (dashboardId) => {
    const updated = get().tables.filter(t => t.dashboardId !== dashboardId);
    saveAll(updated);
    set({ tables: updated });
  },
}));
