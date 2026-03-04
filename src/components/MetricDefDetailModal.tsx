import { useState, useEffect } from 'react';
import { X, Loader2, AlertCircle, BarChart3, Database, Code2, GitBranch, Copy, Check } from 'lucide-react';
import type { MetricDef } from '../types';
import { useUnifiedChatStore } from '../unifiedChatStore';
import { useMetricStore } from '../metricStore';
import { useProcessedTableStore } from '../processedTableStore';
import { fetchMetricLineage } from '../api';
import type { MetricLineageResponse } from '../api';

const LEVEL_COLORS: Record<string, { bg: string; border: string; header: string; text: string }> = {
  source:    { bg: '#eff6ff', border: '#93c5fd', header: '#dbeafe', text: '#1e40af' },
  processed: { bg: '#fefce8', border: '#fde047', header: '#fef9c3', text: '#854d0e' },
  metric:    { bg: '#f0fdf4', border: '#86efac', header: '#dcfce7', text: '#166534' },
};

type Tab = 'info' | 'sql' | 'lineage';

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = () => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <button onClick={handleCopy} className="p-1 rounded text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 transition-colors cursor-pointer" title="复制">
      {copied ? <Check className="w-3.5 h-3.5 text-emerald-500" /> : <Copy className="w-3.5 h-3.5" />}
    </button>
  );
}

function LineageSVG({ data }: { data: MetricLineageResponse }) {
  const layers = data.layers || [];
  const edges = data.edges || [];
  const colW = 180;
  const fieldH = 22;
  const headerH = 34;
  const padY = 8;
  const layerGap = 200;
  const tableGap = 16;
  const startX = 30;
  const startY = 30;

  type Box = { name: string; role: string; fields: string[]; x: number; y: number; w: number; h: number; level: string };
  const boxes: Box[] = [];
  layers.forEach((layer, li) => {
    const x = startX + li * (colW + layerGap);
    let y = startY;
    for (const tbl of layer.tables) {
      const h = headerH + Math.max(tbl.fields.length, 1) * fieldH + padY;
      boxes.push({ ...tbl, x, y, w: colW, h, level: layer.level });
      y += h + tableGap;
    }
  });

  const getFieldPos = (tableName: string, fieldName: string, side: 'left' | 'right') => {
    const box = boxes.find(b => b.name === tableName);
    if (!box) return null;
    const fi = box.fields.indexOf(fieldName);
    const fy = box.y + headerH + (fi >= 0 ? fi : 0) * fieldH + fieldH / 2;
    return { x: side === 'right' ? box.x + box.w : box.x, y: fy };
  };

  const maxY = boxes.reduce((m, b) => Math.max(m, b.y + b.h), 0);
  const maxX = boxes.reduce((m, b) => Math.max(m, b.x + b.w), 0);
  const svgW = maxX + 40;
  const svgH = maxY + 40;

  return (
    <svg width={svgW} height={svgH} className="block">
      <defs>
        <marker id="ml-arrow" markerWidth="7" markerHeight="5" refX="7" refY="2.5" orient="auto">
          <polygon points="0 0, 7 2.5, 0 5" fill="#6366f1" />
        </marker>
      </defs>
      {edges.map((e, i) => {
        const from = getFieldPos(e.from.table, e.from.field, 'right');
        const to = getFieldPos(e.to.table, e.to.field, 'left');
        if (!from || !to) return null;
        const midX = (from.x + to.x) / 2;
        return (
          <g key={`edge-${i}`}>
            <path d={`M${from.x},${from.y} C${midX},${from.y} ${midX},${to.y} ${to.x},${to.y}`}
              fill="none" stroke="#6366f1" strokeWidth="1.2" markerEnd="url(#ml-arrow)" opacity="0.5" />
            {e.transform && e.transform !== '直接映射' && (
              <g>
                <rect x={midX - 30} y={(from.y + to.y) / 2 - 9} width={60} height={18} rx="9" fill="#eef2ff" stroke="#c7d2fe" strokeWidth="0.8" />
                <text x={midX} y={(from.y + to.y) / 2 + 3} textAnchor="middle" fontSize="8" fill="#4338ca" fontWeight="500">
                  {e.transform.length > 8 ? e.transform.slice(0, 8) + '…' : e.transform}
                </text>
              </g>
            )}
          </g>
        );
      })}
      {boxes.map((box, bi) => {
        const colors = LEVEL_COLORS[box.level] || LEVEL_COLORS.source;
        return (
          <g key={`box-${bi}`}>
            <rect x={box.x} y={box.y} width={box.w} height={box.h} rx="8" fill={colors.bg} stroke={colors.border} strokeWidth="1.5" />
            <rect x={box.x} y={box.y} width={box.w} height={headerH} rx="8" fill={colors.header} />
            <rect x={box.x} y={box.y + headerH - 4} width={box.w} height="4" fill={colors.header} />
            <rect x={box.x + box.w - 38} y={box.y + 9} width={30} height={16} rx="8" fill={colors.text} opacity="0.1" />
            <text x={box.x + box.w - 23} y={box.y + 21} textAnchor="middle" fontSize="8" fill={colors.text} fontWeight="600">{box.role}</text>
            <text x={box.x + 10} y={box.y + 22} fontSize="11" fontWeight="600" fill={colors.text}>
              {box.name.length > 18 ? box.name.slice(0, 18) + '…' : box.name}
            </text>
            {box.fields.map((f, fi) => (
              <text key={fi} x={box.x + 12} y={box.y + headerH + fi * fieldH + 15} fontSize="10" fill="#475569">
                {f.length > 22 ? f.slice(0, 22) + '…' : f}
              </text>
            ))}
          </g>
        );
      })}
      {layers.map((layer, li) => {
        const x = startX + li * (colW + layerGap) + colW / 2;
        return (
          <text key={`label-${li}`} x={x} y={16} textAnchor="middle" fontSize="10" fill="#94a3b8" fontWeight="500">{layer.label}</text>
        );
      })}
    </svg>
  );
}

const AGG_LABELS: Record<string, string> = {
  SUM: '求和', COUNT: '计数', AVG: '平均值', COUNT_DISTINCT: '去重计数', MAX: '最大值', MIN: '最小值', '自定义': '自定义计算',
};

function InfoTab({ def, relatedMetrics }: { def: MetricDef; relatedMetrics: { name: string; sql: string; chartType: string }[] }) {
  return (
    <div className="space-y-4">
      {/* 基本信息 */}
      <div className="grid grid-cols-2 gap-3">
        <div className="bg-slate-50 rounded-lg p-3 border border-slate-200">
          <p className="text-[10px] text-slate-400 mb-1">指标名称</p>
          <p className="text-sm font-medium text-slate-800">{def.name}</p>
        </div>
        <div className="bg-slate-50 rounded-lg p-3 border border-slate-200">
          <p className="text-[10px] text-slate-400 mb-1">聚合方式</p>
          <p className="text-sm font-medium text-slate-800">
            <span className="inline-block px-1.5 py-0.5 rounded text-[11px] bg-indigo-50 text-indigo-700 font-medium">
              {def.aggregation}
            </span>
            <span className="text-slate-500 ml-1.5 text-xs">{AGG_LABELS[def.aggregation] || ''}</span>
          </p>
        </div>
        <div className="bg-slate-50 rounded-lg p-3 border border-slate-200">
          <p className="text-[10px] text-slate-400 mb-1">度量字段</p>
          <p className="text-sm font-mono text-slate-800">{def.measureField}</p>
        </div>
        <div className="bg-slate-50 rounded-lg p-3 border border-slate-200">
          <p className="text-[10px] text-slate-400 mb-1">创建时间</p>
          <p className="text-sm text-slate-800">{new Date(def.createdAt).toLocaleString('zh-CN')}</p>
        </div>
      </div>

      {/* 计算逻辑 */}
      <div className="bg-slate-50 rounded-lg p-3 border border-slate-200">
        <p className="text-[10px] text-slate-400 mb-1">计算逻辑</p>
        <p className="text-sm text-slate-700">{def.definition}</p>
      </div>

      {/* 涉及表 */}
      <div className="bg-slate-50 rounded-lg p-3 border border-slate-200">
        <p className="text-[10px] text-slate-400 mb-1.5">涉及表</p>
        <div className="flex flex-wrap gap-1.5">
          {def.tables.map(t => (
            <span key={t} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] bg-white border border-slate-200 text-slate-600">
              <Database className="w-3 h-3 text-amber-500" />
              {t}
            </span>
          ))}
        </div>
      </div>

      {/* 关联的监控数据 */}
      {relatedMetrics.length > 0 && (
        <div>
          <p className="text-xs font-medium text-slate-600 mb-2">关联的监控数据 ({relatedMetrics.length})</p>
          <div className="space-y-2">
            {relatedMetrics.map((m, i) => (
              <div key={i} className="bg-slate-50 rounded-lg p-3 border border-slate-200">
                <div className="flex items-center gap-2 mb-1.5">
                  <BarChart3 className="w-3 h-3 text-indigo-500" />
                  <span className="text-xs font-medium text-slate-700">{m.name}</span>
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-500">{m.chartType}</span>
                </div>
                <pre className="text-[10px] font-mono text-slate-500 bg-white rounded p-2 border border-slate-100 overflow-x-auto whitespace-pre-wrap">{m.sql}</pre>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function SqlTab({ def, relatedMetrics }: { def: MetricDef; relatedMetrics: { name: string; sql: string; chartType: string }[] }) {
  // 指标公式：构造完整 SQL
  const tableName = def.tables.length > 0 ? def.tables[0] : '<table>';
  const formula = `SELECT ${def.aggregation}(${def.measureField}) AS ${def.name}\nFROM ${tableName}`;

  return (
    <div className="space-y-4">
      {/* 指标公式 */}
      <div>
        <div className="flex items-center justify-between mb-1.5">
          <p className="text-xs font-medium text-slate-600">指标公式</p>
          <CopyButton text={formula} />
        </div>
        <div className="bg-slate-900 rounded-lg p-3 overflow-x-auto">
          <code className="text-sm text-emerald-400 font-mono">{formula}</code>
        </div>
      </div>

      {/* 关联查询 SQL */}
      {relatedMetrics.length > 0 ? (
        relatedMetrics.map((m, i) => (
          <div key={i}>
            <div className="flex items-center justify-between mb-1.5">
              <div className="flex items-center gap-2">
                <p className="text-xs font-medium text-slate-600">查询 SQL</p>
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-500">{m.name}</span>
              </div>
              <CopyButton text={m.sql} />
            </div>
            <pre className="bg-slate-900 rounded-lg p-3 text-[11px] text-slate-200 font-mono overflow-x-auto whitespace-pre-wrap leading-relaxed">{m.sql}</pre>
          </div>
        ))
      ) : (
        <div className="text-center py-8">
          <Code2 className="w-8 h-8 text-slate-300 mx-auto mb-2" />
          <p className="text-xs text-slate-400">暂无关联的查询 SQL</p>
          <p className="text-[10px] text-slate-400 mt-1">通过「添加监控数据」生成查询后，SQL 会显示在这里</p>
        </div>
      )}
    </div>
  );
}

function LineageTab({ def, connectionString, allProcessedTables }: {
  def: MetricDef;
  connectionString: string | null;
  allProcessedTables: { database: string; table: string; sourceTables: string[]; fieldMappings: { targetField: string; sourceTable: string; sourceExpr: string; transform: string }[]; insertSql: string }[];
}) {
  const [lineage, setLineage] = useState<MetricLineageResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!connectionString) {
      setLoading(false);
      setError('请先连接数据库');
      return;
    }
    setLoading(true);
    setError('');

    // 传递所有加工表，让后端根据指标涉及的表追溯完整链路
    const pts = allProcessedTables.map(pt => ({
      database: pt.database,
      table: pt.table,
      sourceTables: pt.sourceTables,
      fieldMappings: pt.fieldMappings,
      insertSql: pt.insertSql,
    }));

    fetchMetricLineage({
      metricDef: { name: def.name, definition: def.definition, tables: def.tables, aggregation: def.aggregation, measureField: def.measureField },
      processedTables: pts,
      connectionString,
    })
      .then(data => setLineage(data))
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, [def, connectionString, allProcessedTables]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16 text-slate-400">
        <Loader2 className="w-5 h-5 animate-spin mr-2" />
        <span className="text-sm">正在分析指标全链路血缘...</span>
      </div>
    );
  }
  if (error) {
    return (
      <div className="flex items-center justify-center py-16">
        <AlertCircle className="w-5 h-5 text-red-400 mr-2" />
        <span className="text-sm text-red-600">{error}</span>
      </div>
    );
  }
  if (!lineage) return null;

  return (
    <div>
      {lineage.summary && (
        <div className="bg-indigo-50 rounded-lg px-4 py-2 mb-4">
          <p className="text-xs text-indigo-700">{lineage.summary}</p>
        </div>
      )}
      <div className="overflow-x-auto">
        <LineageSVG data={lineage} />
      </div>
    </div>
  );
}

const TABS: { key: Tab; label: string; icon: typeof BarChart3 }[] = [
  { key: 'info', label: '指标信息', icon: BarChart3 },
  { key: 'sql', label: 'SQL', icon: Code2 },
  { key: 'lineage', label: '数据血缘', icon: GitBranch },
];

export default function MetricDefDetailModal({ def, onClose }: { def: MetricDef; onClose: () => void }) {
  const connectionString = useUnifiedChatStore(s => s.connectionString);
  const allProcessedTables = useProcessedTableStore(s => s.tables);
  const allMetrics = useMetricStore(s => s.metrics);
  const [tab, setTab] = useState<Tab>('info');

  // 找到与该指标定义关联的监控数据（Metric）
  const relatedMetrics = allMetrics
    .filter(m => m.dashboardId === def.dashboardId && m.definition && def.tables.some(t => m.tables?.includes(t)))
    .map(m => ({ name: m.name, sql: m.sql, chartType: m.chartType }));

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-5xl mx-4 overflow-hidden" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-emerald-50 flex items-center justify-center">
              <BarChart3 className="w-4 h-4 text-emerald-600" />
            </div>
            <div>
              <h2 className="text-base font-semibold text-slate-900">{def.name}</h2>
              <p className="text-[11px] text-slate-500">{def.aggregation}({def.measureField}) · {def.definition}</p>
            </div>
          </div>
          <button onClick={onClose} className="p-1 rounded text-slate-400 hover:text-slate-600 hover:bg-slate-100 cursor-pointer transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Tabs */}
        <div className="px-6 border-b border-slate-100 flex gap-0">
          {TABS.map(t => {
            const Icon = t.icon;
            const active = tab === t.key;
            return (
              <button
                key={t.key}
                onClick={() => setTab(t.key)}
                className={`flex items-center gap-1.5 px-4 py-2.5 text-xs font-medium border-b-2 transition-colors cursor-pointer ${
                  active
                    ? 'border-indigo-600 text-indigo-700'
                    : 'border-transparent text-slate-500 hover:text-slate-700 hover:border-slate-300'
                }`}
              >
                <Icon className="w-3.5 h-3.5" />
                {t.label}
              </button>
            );
          })}
        </div>

        {/* Content */}
        <div className="overflow-auto px-6 py-4" style={{ maxHeight: '65vh' }}>
          {tab === 'info' && <InfoTab def={def} relatedMetrics={relatedMetrics} />}
          {tab === 'sql' && <SqlTab def={def} relatedMetrics={relatedMetrics} />}
          {tab === 'lineage' && (
            <LineageTab
              def={def}
              connectionString={connectionString}
              allProcessedTables={allProcessedTables
                .filter(pt => pt.dashboardId === def.dashboardId)
                .map(pt => ({
                  database: pt.database, table: pt.table, sourceTables: pt.sourceTables,
                  fieldMappings: pt.fieldMappings, insertSql: pt.insertSql,
                }))}
            />
          )}
        </div>
      </div>
    </div>
  );
}
