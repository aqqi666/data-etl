import { useEffect, useState, useMemo } from 'react';
import { Database, Table2, ChevronRight, ChevronDown, Loader2, RefreshCw } from 'lucide-react';
import { useSchemaStore } from '../schemaStore';
import { useStore } from '../store';

export default function SchemaTree() {
  const connectionString = useStore(s => s.connectionString);
  const { tree, loading, error, selectedTables, expandedDbs, fetchTree, toggleTable, toggleAllDbTables, expandDb, collapseDb } = useSchemaStore();
  const [panelOpen, setPanelOpen] = useState(false);

  useEffect(() => {
    if (connectionString && tree.length === 0 && !loading) {
      fetchTree(connectionString);
    }
  }, [connectionString, tree.length, loading, fetchTree]);

  // 计算已选库的摘要
  const selectedSummary = useMemo(() => {
    if (selectedTables.size === 0) return '';
    const dbMap = new Map<string, number>();
    for (const key of selectedTables) {
      const db = key.split('.')[0];
      dbMap.set(db, (dbMap.get(db) || 0) + 1);
    }
    return Array.from(dbMap.entries())
      .map(([db, count]) => `${db}(${count})`)
      .join(', ');
  }, [selectedTables]);

  if (!connectionString) return null;

  return (
    <div className="flex-shrink-0 border-b border-slate-200 bg-slate-50/50">
      {/* Header - 点击展开/收起 */}
      <div
        className="flex items-center justify-between px-3 py-1.5 cursor-pointer hover:bg-slate-100/60 transition-colors"
        onClick={() => setPanelOpen(v => !v)}
      >
        <div className="flex items-center gap-1.5 min-w-0 flex-1">
          {panelOpen
            ? <ChevronDown className="w-3 h-3 text-slate-400 flex-shrink-0" />
            : <ChevronRight className="w-3 h-3 text-slate-400 flex-shrink-0" />
          }
          <Database className="w-3 h-3 text-slate-400 flex-shrink-0" />
          <span className="text-[11px] font-medium text-slate-600 flex-shrink-0">库表</span>
          {!panelOpen && selectedSummary && (
            <span className="text-[10px] text-indigo-600 truncate ml-1" title={selectedSummary}>
              {selectedSummary}
            </span>
          )}
        </div>
        <button
          onClick={e => { e.stopPropagation(); connectionString && fetchTree(connectionString); }}
          disabled={loading}
          className="p-0.5 rounded text-slate-400 hover:text-slate-600 hover:bg-slate-200 transition-colors cursor-pointer disabled:opacity-40"
          title="刷新"
        >
          <RefreshCw className={`w-3 h-3 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {/* Tree - 仅展开时显示 */}
      {panelOpen && (
        <div className="max-h-48 overflow-y-auto px-1 pb-1.5">
          {loading && tree.length === 0 && (
            <div className="flex items-center gap-1.5 px-2 py-2 text-[11px] text-slate-400">
              <Loader2 className="w-3 h-3 animate-spin" /> 加载中...
            </div>
          )}
          {error && (
            <div className="px-2 py-1.5 text-[11px] text-red-500">{error}</div>
          )}
          {tree.map(db => {
            const isExpanded = expandedDbs.has(db.database);
            const dbTables = db.tables.map(t => `${db.database}.${t}`);
            const selectedInDb = dbTables.filter(k => selectedTables.has(k)).length;
            const allSelected = dbTables.length > 0 && selectedInDb === dbTables.length;
            const someSelected = selectedInDb > 0 && !allSelected;

            return (
              <div key={db.database}>
                <div className="flex items-center gap-0.5 px-1 py-[3px] rounded hover:bg-slate-100 group">
                  <button
                    onClick={() => isExpanded ? collapseDb(db.database) : expandDb(db.database)}
                    className="p-0.5 text-slate-400 cursor-pointer"
                  >
                    {isExpanded
                      ? <ChevronDown className="w-3 h-3" />
                      : <ChevronRight className="w-3 h-3" />
                    }
                  </button>
                  <label className="flex items-center gap-1.5 flex-1 min-w-0 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={allSelected}
                      ref={el => { if (el) el.indeterminate = someSelected; }}
                      onChange={() => toggleAllDbTables(db.database)}
                      className="w-3 h-3 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500 cursor-pointer"
                    />
                    <Database className="w-3 h-3 text-amber-500 flex-shrink-0" />
                    <span className="text-[11px] text-slate-700 truncate">{db.database}</span>
                    <span className="text-[10px] text-slate-400 flex-shrink-0">({db.tables.length})</span>
                  </label>
                </div>
                {isExpanded && (
                  <div className="ml-5">
                    {db.tables.map(tbl => {
                      const key = `${db.database}.${tbl}`;
                      const checked = selectedTables.has(key);
                      return (
                        <label
                          key={key}
                          className="flex items-center gap-1.5 px-1 py-[2px] rounded hover:bg-slate-100 cursor-pointer"
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => toggleTable(db.database, tbl)}
                            className="w-3 h-3 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500 cursor-pointer"
                          />
                          <Table2 className="w-3 h-3 text-slate-400 flex-shrink-0" />
                          <span className={`text-[11px] truncate ${checked ? 'text-indigo-700 font-medium' : 'text-slate-600'}`}>
                            {tbl}
                          </span>
                        </label>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
