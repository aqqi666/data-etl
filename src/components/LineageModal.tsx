import { useState, useEffect } from 'react';
import { X, Database, Loader2, AlertCircle } from 'lucide-react';
import type { ProcessedTable } from '../types';
import { useStore } from '../store';
import { fetchLineage } from '../api';
import type { LineageResponse } from '../api';

interface Props {
  table: ProcessedTable;
  onClose: () => void;
  onAddMetric: (tableId: string) => void;
}

const ROLE_COLORS: Record<string, { bg: string; border: string; header: string; text: string; badge: string }> = {
  '基表': { bg: '#eff6ff', border: '#93c5fd', header: '#dbeafe', text: '#1e40af', badge: '#3b82f6' },
  '维表': { bg: '#fefce8', border: '#fde047', header: '#fef9c3', text: '#854d0e', badge: '#eab308' },
  '关联表': { bg: '#fdf2f8', border: '#f9a8d4', header: '#fce7f3', text: '#9d174d', badge: '#ec4899' },
};
const TARGET_COLOR = { bg: '#f0fdf4', border: '#86efac', header: '#dcfce7', text: '#166534', badge: '#22c55e' };

function LineageDiagram({ data }: { data: LineageResponse }) {
  const sources = data.sourceTables || [];
  const mappings = data.fieldMappings || [];

  // Group mappings by source table
  const sourceFieldMap = new Map<string, Set<string>>();
  for (const m of mappings) {
    if (!sourceFieldMap.has(m.sourceTable)) sourceFieldMap.set(m.sourceTable, new Set());
    sourceFieldMap.get(m.sourceTable)!.add(m.sourceField);
  }

  const targetFields = mappings.map(m => m.targetField);

  // Layout
  const colW = 200;
  const fieldH = 22;
  const headerH = 36;
  const padY = 8;
  const gapX = 220;
  const sourceX = 30;
  const targetX = sourceX + colW + gapX;

  // Source boxes
  const sourceGap = 20;
  let curY = 30;
  const sourceBoxes = sources.map(src => {
    const fields = [...(sourceFieldMap.get(src.name) || [])];
    const h = headerH + Math.max(fields.length, 1) * fieldH + padY;
    const box = { ...src, x: sourceX, y: curY, w: colW, h, fields };
    curY += h + sourceGap;
    return box;
  });

  // Target box
  const targetH = headerH + Math.max(targetFields.length, 1) * fieldH + padY;
  const totalSourceH = sourceBoxes.length > 0
    ? sourceBoxes[sourceBoxes.length - 1].y + sourceBoxes[sourceBoxes.length - 1].h - sourceBoxes[0].y
    : targetH;
  const targetY = sourceBoxes.length > 0
    ? sourceBoxes[0].y + Math.max(0, (totalSourceH - targetH) / 2)
    : 30;

  const svgH = Math.max(curY + 20, targetY + targetH + 40);
  const svgW = targetX + colW + 40;

  // Lines
  const lines: { x1: number; y1: number; x2: number; y2: number; transform: string }[] = [];
  mappings.forEach((m, mi) => {
    const srcBox = sourceBoxes.find(s => s.name === m.sourceTable);
    if (!srcBox) return;
    const srcFieldIdx = srcBox.fields.indexOf(m.sourceField);
    const y1 = srcBox.y + headerH + (srcFieldIdx >= 0 ? srcFieldIdx : 0) * fieldH + fieldH / 2;
    const y2 = targetY + headerH + mi * fieldH + fieldH / 2;
    lines.push({ x1: srcBox.x + srcBox.w, y1, x2: targetX, y2, transform: m.transform });
  });

  return (
    <svg width={svgW} height={svgH} className="block">
      <defs>
        <marker id="lm-arrow" markerWidth="7" markerHeight="5" refX="7" refY="2.5" orient="auto">
          <polygon points="0 0, 7 2.5, 0 5" fill="#6366f1" />
        </marker>
      </defs>

      {/* Connection lines */}
      {lines.map((l, i) => {
        const midX = (l.x1 + l.x2) / 2;
        const isDirect = l.transform === '直接映射';
        return (
          <g key={`line-${i}`}>
            <path
              d={`M${l.x1},${l.y1} C${midX},${l.y1} ${midX},${l.y2} ${l.x2},${l.y2}`}
              fill="none" stroke="#6366f1" strokeWidth="1.2"
              strokeDasharray={isDirect ? 'none' : '5 3'}
              markerEnd="url(#lm-arrow)" opacity="0.5"
            />
            {!isDirect && (
              <g>
                <rect
                  x={midX - 36} y={(l.y1 + l.y2) / 2 - 9}
                  width={72} height={18} rx="9"
                  fill="#eef2ff" stroke="#c7d2fe" strokeWidth="0.8"
                />
                <text x={midX} y={(l.y1 + l.y2) / 2 + 3}
                  textAnchor="middle" fontSize="9" fill="#4338ca" fontWeight="500">
                  {l.transform.length > 10 ? l.transform.slice(0, 10) + '…' : l.transform}
                </text>
              </g>
            )}
          </g>
        );
      })}

      {/* Source table boxes */}
      {sourceBoxes.map((src, si) => {
        const colors = ROLE_COLORS[src.role] || ROLE_COLORS['关联表'];
        return (
          <g key={`src-${si}`}>
            <rect x={src.x} y={src.y} width={src.w} height={src.h} rx="8"
              fill={colors.bg} stroke={colors.border} strokeWidth="1.5" />
            <rect x={src.x} y={src.y} width={src.w} height={headerH} rx="8"
              fill={colors.header} />
            <rect x={src.x} y={src.y + headerH - 4} width={src.w} height="4" fill={colors.header} />
            {/* Role badge */}
            <rect x={src.x + src.w - 38} y={src.y + 10} width={30} height={16} rx="8" fill={colors.badge} opacity="0.15" />
            <text x={src.x + src.w - 23} y={src.y + 22} textAnchor="middle" fontSize="9" fill={colors.badge} fontWeight="600">
              {src.role}
            </text>
            {/* Table name */}
            <text x={src.x + 10} y={src.y + 23} fontSize="11" fontWeight="600" fill={colors.text}>
              {src.name.length > 20 ? src.name.slice(0, 20) + '…' : src.name}
            </text>
            {/* Fields */}
            {src.fields.map((f, fi) => (
              <text key={fi} x={src.x + 14} y={src.y + headerH + fi * fieldH + 15}
                fontSize="10" fill="#475569">
                {f}
              </text>
            ))}
            {src.fields.length === 0 && (
              <text x={src.x + 14} y={src.y + headerH + 15} fontSize="10" fill="#94a3b8" fontStyle="italic">
                (无直接字段引用)
              </text>
            )}
            {/* Join info */}
            {src.joinType && src.joinType !== '无（主表）' && (
              <text x={src.x + src.w + 4} y={src.y + headerH / 2 + 4}
                fontSize="8" fill="#94a3b8">
                {src.joinType}
              </text>
            )}
          </g>
        );
      })}

      {/* Target table box */}
      <g>
        <rect x={targetX} y={targetY} width={colW} height={targetH} rx="8"
          fill={TARGET_COLOR.bg} stroke={TARGET_COLOR.border} strokeWidth="1.5" />
        <rect x={targetX} y={targetY} width={colW} height={headerH} rx="8"
          fill={TARGET_COLOR.header} />
        <rect x={targetX} y={targetY + headerH - 4} width={colW} height="4" fill={TARGET_COLOR.header} />
        <rect x={targetX + colW - 46} y={targetY + 10} width={38} height={16} rx="8" fill={TARGET_COLOR.badge} opacity="0.15" />
        <text x={targetX + colW - 27} y={targetY + 22} textAnchor="middle" fontSize="9" fill={TARGET_COLOR.badge} fontWeight="600">
          目标表
        </text>
        <text x={targetX + 10} y={targetY + 23} fontSize="11" fontWeight="600" fill={TARGET_COLOR.text}>
          {data.targetTable.length > 20 ? data.targetTable.slice(0, 20) + '…' : data.targetTable}
        </text>
        {targetFields.map((f, fi) => (
          <text key={fi} x={targetX + 14} y={targetY + headerH + fi * fieldH + 15}
            fontSize="10" fill="#475569">
            {f}
          </text>
        ))}
      </g>
    </svg>
  );
}

export default function LineageModal({ table, onClose, onAddMetric }: Props) {
  const connectionString = useStore(s => s.connectionString);
  const [lineage, setLineage] = useState<LineageResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const targetName = `${table.database}.${table.table}`;

  useEffect(() => {
    if (!table.insertSql || !connectionString) {
      setLoading(false);
      setError(table.insertSql ? '请先连接数据库' : '暂无加工 SQL，无法分析血缘');
      return;
    }
    setLoading(true);
    setError('');
    fetchLineage({ sql: table.insertSql, connectionString, targetTable: targetName })
      .then(data => setLineage(data))
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, [table.insertSql, connectionString, targetName]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-5xl mx-4 overflow-hidden" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Database className="w-4 h-4 text-indigo-500" />
            <h2 className="text-base font-semibold text-slate-900">数据血缘 — {targetName}</h2>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => { onAddMetric(table.id); onClose(); }}
              className="px-3 py-1.5 text-xs font-medium text-white bg-indigo-600 rounded-lg hover:bg-indigo-700 transition-colors cursor-pointer"
            >
              基于此表添加监控
            </button>
            <button onClick={onClose} className="p-1 rounded text-slate-400 hover:text-slate-600 hover:bg-slate-100 cursor-pointer transition-colors">
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="overflow-auto" style={{ maxHeight: '70vh' }}>
          {loading && (
            <div className="flex items-center justify-center py-16 text-slate-400">
              <Loader2 className="w-5 h-5 animate-spin mr-2" />
              <span className="text-sm">正在分析数据血缘...</span>
            </div>
          )}

          {error && !loading && (
            <div className="flex items-center justify-center py-16">
              <AlertCircle className="w-5 h-5 text-red-400 mr-2" />
              <span className="text-sm text-red-600">{error}</span>
            </div>
          )}

          {lineage && !loading && (
            <div className="px-6 py-4">
              {/* SVG Diagram */}
              <div className="overflow-x-auto mb-4">
                <LineageDiagram data={lineage} />
              </div>

              {/* Detail cards */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-2">
                {/* JOIN Relations */}
                {lineage.joinRelations && lineage.joinRelations.length > 0 && (
                  <div className="bg-slate-50 rounded-lg p-3 border border-slate-200">
                    <p className="text-xs font-semibold text-slate-700 mb-2">JOIN 关系</p>
                    <div className="space-y-1.5">
                      {lineage.joinRelations.map((j, i) => (
                        <div key={i} className="text-[11px] text-slate-600">
                          <span className="font-medium text-indigo-600">{j.joinType}</span>
                          {' '}{j.rightTable}
                          <span className="text-slate-400"> ON </span>
                          <span className="font-mono text-[10px]">{j.condition}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Filters & GroupBy */}
                <div className="bg-slate-50 rounded-lg p-3 border border-slate-200">
                  {lineage.groupBy && (
                    <div className="mb-2">
                      <p className="text-xs font-semibold text-slate-700 mb-1">GROUP BY</p>
                      <p className="text-[11px] text-slate-600 font-mono">{lineage.groupBy}</p>
                    </div>
                  )}
                  {lineage.filters && (
                    <div>
                      <p className="text-xs font-semibold text-slate-700 mb-1">WHERE 条件</p>
                      <p className="text-[11px] text-slate-600 font-mono">{lineage.filters}</p>
                    </div>
                  )}
                  {!lineage.groupBy && !lineage.filters && (
                    <p className="text-xs text-slate-400">无 GROUP BY 或 WHERE 条件</p>
                  )}
                </div>
              </div>

              {/* Field mapping table */}
              {lineage.fieldMappings && lineage.fieldMappings.length > 0 && (
                <div className="mt-3">
                  <p className="text-xs font-semibold text-slate-700 mb-2">字段映射明细</p>
                  <div className="overflow-x-auto border border-slate-200 rounded-lg">
                    <table className="w-full text-[11px]">
                      <thead>
                        <tr className="bg-slate-50">
                          <th className="px-3 py-2 text-left font-medium text-slate-600">目标字段</th>
                          <th className="px-3 py-2 text-left font-medium text-slate-600">来源表</th>
                          <th className="px-3 py-2 text-left font-medium text-slate-600">来源字段</th>
                          <th className="px-3 py-2 text-left font-medium text-slate-600">加工逻辑</th>
                          <th className="px-3 py-2 text-left font-medium text-slate-600">SQL 表达式</th>
                        </tr>
                      </thead>
                      <tbody>
                        {lineage.fieldMappings.map((m, i) => (
                          <tr key={i} className={i % 2 === 0 ? '' : 'bg-slate-50/50'}>
                            <td className="px-3 py-1.5 font-medium text-indigo-700">{m.targetField}</td>
                            <td className="px-3 py-1.5 text-slate-600">{m.sourceTable}</td>
                            <td className="px-3 py-1.5 text-slate-600">{m.sourceField}</td>
                            <td className="px-3 py-1.5">
                              <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-medium ${
                                m.transform === '直接映射'
                                  ? 'bg-green-50 text-green-700'
                                  : 'bg-purple-50 text-purple-700'
                              }`}>
                                {m.transform}
                              </span>
                            </td>
                            <td className="px-3 py-1.5 font-mono text-[10px] text-slate-500 max-w-[200px] truncate" title={m.expression}>
                              {m.expression}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* SQL detail */}
        {table.insertSql && (
          <div className="px-6 pb-4 border-t border-slate-100 pt-3">
            <details className="group">
              <summary className="text-xs text-slate-500 cursor-pointer hover:text-indigo-600 transition-colors">
                查看加工 SQL
              </summary>
              <pre className="mt-2 p-3 bg-slate-50 rounded-lg text-[11px] text-slate-700 font-mono overflow-x-auto whitespace-pre-wrap border border-slate-200">
                {table.insertSql}
              </pre>
            </details>
          </div>
        )}
      </div>
    </div>
  );
}
