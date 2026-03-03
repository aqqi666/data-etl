import { create } from 'zustand';
import { fetchTableList } from './api';
import type { DatabaseTree } from './api';

const STORAGE_PREFIX = 'etl-schema-sel-';

function persistSelection(dashboardId: string, selected: Set<string>) {
  try { localStorage.setItem(STORAGE_PREFIX + dashboardId, JSON.stringify([...selected])); } catch { /* */ }
}
function loadSelection(dashboardId: string): Set<string> | null {
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + dashboardId);
    if (!raw) return null;
    return new Set(JSON.parse(raw) as string[]);
  } catch { return null; }
}

interface SchemaState {
  dashboardId: string | null;
  /** 所有库表树 */
  tree: DatabaseTree[];
  /** 是否正在加载 */
  loading: boolean;
  /** 加载错误 */
  error: string | null;
  /** 已选中的表（格式 db.table） */
  selectedTables: Set<string>;
  /** 已展开的库 */
  expandedDbs: Set<string>;

  loadForDashboard: (dashboardId: string) => void;
  fetchTree: (connectionString: string) => Promise<void>;
  toggleDb: (db: string) => void;
  toggleTable: (db: string, table: string) => void;
  toggleAllDbTables: (db: string) => void;
  expandDb: (db: string) => void;
  collapseDb: (db: string) => void;
  clearSelection: () => void;
  reset: () => void;
}

export const useSchemaStore = create<SchemaState>((set, get) => ({
  dashboardId: null,
  tree: [],
  loading: false,
  error: null,
  selectedTables: new Set(),
  expandedDbs: new Set(),

  loadForDashboard: (dashboardId: string) => {
    const saved = loadSelection(dashboardId);
    set({ dashboardId, selectedTables: saved || new Set() });
  },

  fetchTree: async (connectionString: string) => {
    set({ loading: true, error: null });
    try {
      const data = await fetchTableList(connectionString);
      set({ tree: data.databases || [], loading: false });
    } catch (e) {
      set({ error: e instanceof Error ? e.message : '加载失败', loading: false });
    }
  },

  toggleTable: (db, table) => {
    const key = `${db}.${table}`;
    const next = new Set(get().selectedTables);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    set({ selectedTables: next });
    const { dashboardId } = get();
    if (dashboardId) persistSelection(dashboardId, next);
  },

  toggleAllDbTables: (db) => {
    const { tree, selectedTables } = get();
    const dbNode = tree.find(d => d.database === db);
    if (!dbNode) return;
    const allKeys = dbNode.tables.map(t => `${db}.${t}`);
    const allSelected = allKeys.every(k => selectedTables.has(k));
    const next = new Set(selectedTables);
    if (allSelected) {
      allKeys.forEach(k => next.delete(k));
    } else {
      allKeys.forEach(k => next.add(k));
    }
    set({ selectedTables: next });
    const { dashboardId } = get();
    if (dashboardId) persistSelection(dashboardId, next);
  },

  toggleDb: (db) => {
    get().toggleAllDbTables(db);
  },

  expandDb: (db) => {
    const next = new Set(get().expandedDbs);
    next.add(db);
    set({ expandedDbs: next });
  },

  collapseDb: (db) => {
    const next = new Set(get().expandedDbs);
    next.delete(db);
    set({ expandedDbs: next });
  },

  clearSelection: () => {
    set({ selectedTables: new Set() });
    const { dashboardId } = get();
    if (dashboardId) persistSelection(dashboardId, new Set());
  },

  reset: () => {
    const { dashboardId } = get();
    set({ tree: [], loading: false, error: null, selectedTables: new Set(), expandedDbs: new Set() });
    if (dashboardId) persistSelection(dashboardId, new Set());
  },
}));
