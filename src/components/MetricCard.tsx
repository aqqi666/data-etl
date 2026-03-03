import { useState } from 'react';
import { Trash2, RefreshCw, Hash, BarChart3, TrendingUp, PieChart, Table2, X, Copy, Check, Code2 } from 'lucide-react';
import type { Metric, ChartType } from '../types';
import { useMetricStore } from '../metricStore';

const COLORS = ['#6366f1', '#8b5cf6', '#ec4899', '#f59e0b', '#10b981', '#06b6d4', '#f43f5e', '#84cc16'];

function fmt(v: number): string {
  if (Math.abs(v) >= 1e6) return (v / 1e6).toFixed(1) + 'M';
  if (Math.abs(v) >= 1e4) return (v / 1e4).toFixed(1) + 'W';
  if (Number.isInteger(v)) return v.toLocaleString('zh-CN');
  return v.toLocaleString('zh-CN', { maximumFractionDigits: 2 });
}

/* ── NumberChart ── */
function NumberChart({ data, definition }: { data: Record<string, unknown>[]; definition?: string }) {
  if (!data || data.length === 0) return <p className="text-slate-400 text-sm">无数据</p>;
  const row = data[0];
  const keys = Object.keys(row);

  // 主数值：取最后一个非同比/环比字段
  const ratioPatterns = /同比|环比|yoy|mom|qoq|growth|rate|增长率|变化率/i;
  const mainKeys = keys.filter(k => !ratioPatterns.test(k));
  const ratioKeys = keys.filter(k => ratioPatterns.test(k));

  const mainKey = mainKeys.length > 0 ? mainKeys[mainKeys.length - 1] : keys[keys.length - 1];
  const labelKey = mainKeys.length > 1 ? mainKeys[0] : null;
  const val = row[mainKey];
  const label = labelKey ? String(row[labelKey] ?? '') : mainKey;
  const num = Number(val);
  const display = isNaN(num) ? String(val) : fmt(num);

  // 从 definition 判断是否需要显示同比/环比
  const wantYoy = definition && /同比/.test(definition);
  const wantMom = definition && /环比/.test(definition);

  // 从数据列中提取同比/环比值
  const findRatio = (pattern: RegExp) => {
    const key = ratioKeys.find(k => pattern.test(k)) || keys.find(k => pattern.test(k));
    if (!key) return null;
    const v = Number(row[key]);
    if (isNaN(v)) return null;
    return { key, value: v };
  };

  const yoy = wantYoy ? findRatio(/同比|yoy/i) : null;
  const mom = wantMom ? findRatio(/环比|mom|qoq/i) : null;

  const RatioTag = ({ label: rLabel, value }: { label: string; value: number }) => {
    const isUp = value > 0;
    const isZero = value === 0;
    const color = isZero ? 'text-slate-500' : isUp ? 'text-emerald-600' : 'text-red-500';
    const arrow = isZero ? '' : isUp ? '↑' : '↓';
    // 如果值看起来已经是百分比（绝对值 < 10 左右），直接显示；否则当作百分比
    const displayVal = Math.abs(value) > 100 ? fmt(value) : `${Math.abs(value).toFixed(2)}%`;
    return (
      <div className="flex items-center gap-1">
        <span className="text-[10px] text-slate-400">{rLabel}</span>
        <span className={`text-xs font-medium ${color}`}>{arrow} {displayVal}</span>
      </div>
    );
  };

  return (
    <div className="flex flex-col items-center justify-center py-3">
      <span className="text-3xl font-bold text-slate-900">{display}</span>
      {label && <span className="text-[11px] text-slate-500 mt-1">{label}</span>}
      {(yoy || mom) && (
        <div className="flex items-center gap-3 mt-2">
          {yoy && <RatioTag label="同比" value={yoy.value} />}
          {mom && <RatioTag label="环比" value={mom.value} />}
        </div>
      )}
    </div>
  );
}

/* ── BarChart ── */
function BarChartViz({ data }: { data: Record<string, unknown>[] }) {
  if (!data || data.length === 0) return <p className="text-slate-400 text-sm">无数据</p>;
  const keys = Object.keys(data[0]);
  const labelKey = keys[0];
  const valueKey = keys[keys.length - 1];
  const values = data.map(r => Number(r[valueKey]) || 0);
  const labels = data.map(r => String(r[labelKey] ?? ''));
  const max = Math.max(...values, 1);

  // Y-axis ticks
  const ticks = 5;
  const yLabels = Array.from({ length: ticks + 1 }, (_, i) => Math.round((max / ticks) * (ticks - i)));

  const chartH = 200;
  const chartW = Math.max(data.length * 52, 300);
  const padL = 50, padR = 16, padT = 28, padB = 40;
  const plotW = chartW - padL - padR;
  const plotH = chartH - padT - padB;
  const barW = Math.min(plotW / data.length * 0.6, 36);

  const [hover, setHover] = useState<number | null>(null);

  return (
    <div className="overflow-x-auto">
      <svg width={chartW} height={chartH} className="block">
        {/* gridlines + Y labels */}
        {yLabels.map((v, i) => {
          const y = padT + (plotH / ticks) * i;
          return (
            <g key={`y-${i}`}>
              <line x1={padL} y1={y} x2={chartW - padR} y2={y} stroke="#e2e8f0" strokeWidth="1" />
              <text x={padL - 6} y={y + 3} textAnchor="end" fontSize="9" fill="#94a3b8">{fmt(v)}</text>
            </g>
          );
        })}
        {/* bars */}
        {values.map((v, i) => {
          const x = padL + (plotW / data.length) * i + (plotW / data.length - barW) / 2;
          const h = (v / max) * plotH;
          const y = padT + plotH - h;
          const isHover = hover === i;
          return (
            <g key={i} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)} style={{ cursor: 'default' }}>
              <rect x={x} y={y} width={barW} height={h} rx={3} fill={isHover ? '#4f46e5' : COLORS[i % COLORS.length]} opacity={isHover ? 1 : 0.85} />
              {/* value label on bar */}
              <text x={x + barW / 2} y={y - 4} textAnchor="middle" fontSize="9" fill="#475569" fontWeight="600">{fmt(v)}</text>
              {/* X label */}
              <text x={x + barW / 2} y={padT + plotH + 14} textAnchor="middle" fontSize="9" fill="#64748b">
                {labels[i].length > 6 ? labels[i].slice(0, 6) + '…' : labels[i]}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

/* ── LineChart ── */
function LineChartViz({ data }: { data: Record<string, unknown>[] }) {
  if (!data || data.length === 0) return <p className="text-slate-400 text-sm">无数据</p>;
  const keys = Object.keys(data[0]);
  const labelKey = keys[0];
  const valueKey = keys[keys.length - 1];
  const values = data.map(r => Number(r[valueKey]) || 0);
  const labels = data.map(r => String(r[labelKey] ?? ''));
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const range = max - min || 1;

  const chartH = 200;
  const chartW = Math.max(data.length * 60, 300);
  const padL = 50, padR = 16, padT = 30, padB = 40;
  const plotW = chartW - padL - padR;
  const plotH = chartH - padT - padB;

  const ticks = 5;
  const yLabels = Array.from({ length: ticks + 1 }, (_, i) => +(max - (range / ticks) * i).toFixed(2));

  const points = values.map((v, i) => ({
    x: padL + (data.length === 1 ? plotW / 2 : (plotW / (data.length - 1)) * i),
    y: padT + plotH - ((v - min) / range) * plotH,
  }));
  const linePath = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x},${p.y}`).join(' ');

  const [hover, setHover] = useState<number | null>(null);

  return (
    <div className="overflow-x-auto">
      <svg width={chartW} height={chartH} className="block">
        {/* gridlines + Y labels */}
        {yLabels.map((v, i) => {
          const y = padT + (plotH / ticks) * i;
          return (
            <g key={`y-${i}`}>
              <line x1={padL} y1={y} x2={chartW - padR} y2={y} stroke="#e2e8f0" strokeWidth="1" />
              <text x={padL - 6} y={y + 3} textAnchor="end" fontSize="9" fill="#94a3b8">{fmt(v)}</text>
            </g>
          );
        })}
        {/* area fill */}
        <path d={`${linePath} L${points[points.length - 1].x},${padT + plotH} L${points[0].x},${padT + plotH} Z`}
          fill="url(#lineGrad)" opacity="0.15" />
        <defs>
          <linearGradient id="lineGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#6366f1" />
            <stop offset="100%" stopColor="#6366f1" stopOpacity="0" />
          </linearGradient>
        </defs>
        {/* line */}
        <path d={linePath} fill="none" stroke="#6366f1" strokeWidth="2" strokeLinejoin="round" />
        {/* dots + X labels */}
        {points.map((p, i) => (
          <g key={i} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)} style={{ cursor: 'default' }}>
            <circle cx={p.x} cy={p.y} r={hover === i ? 5 : 3} fill={hover === i ? '#4f46e5' : '#6366f1'} stroke="#fff" strokeWidth="2" />
            {hover === i && (
              <g>
                <rect x={p.x - 30} y={Math.max(2, p.y - 24)} width={60} height={18} rx={4} fill="#1e293b" />
                <text x={p.x} y={Math.max(2, p.y - 24) + 12} textAnchor="middle" fontSize="10" fill="#fff" fontWeight="600">{fmt(values[i])}</text>
              </g>
            )}
            <text x={p.x} y={padT + plotH + 14} textAnchor="middle" fontSize="9" fill="#64748b">
              {labels[i].length > 6 ? labels[i].slice(0, 6) + '…' : labels[i]}
            </text>
          </g>
        ))}
      </svg>
    </div>
  );
}

/* ── PieChart ── */
function PieChartViz({ data }: { data: Record<string, unknown>[] }) {
  if (!data || data.length === 0) return <p className="text-slate-400 text-sm">无数据</p>;
  const keys = Object.keys(data[0]);
  const labelKey = keys[0];
  const valueKey = keys[keys.length - 1];
  const items = data.map(r => ({ label: String(r[labelKey] ?? ''), value: Math.abs(Number(r[valueKey]) || 0) }));
  const total = items.reduce((s, it) => s + it.value, 0) || 1;

  const cx = 90, cy = 90, r = 65;
  let angle = -Math.PI / 2;

  const [hover, setHover] = useState<number | null>(null);

  const slices = items.map((it, i) => {
    const pct = it.value / total;
    const start = angle;
    angle += pct * 2 * Math.PI;
    const end = angle;
    const large = pct > 0.5 ? 1 : 0;
    const x1 = cx + r * Math.cos(start), y1 = cy + r * Math.sin(start);
    const x2 = cx + r * Math.cos(end), y2 = cy + r * Math.sin(end);
    const mid = (start + end) / 2;
    const lx = cx + (r + 14) * Math.cos(mid), ly = cy + (r + 14) * Math.sin(mid);
    return { path: `M${cx},${cy} L${x1},${y1} A${r},${r} 0 ${large} 1 ${x2},${y2} Z`, color: COLORS[i % COLORS.length], pct, lx, ly, label: it.label, i };
  });

  return (
    <div className="flex items-center gap-4">
      <svg width={200} height={190} className="flex-shrink-0">
        {slices.map(s => (
          <g key={s.i} onMouseEnter={() => setHover(s.i)} onMouseLeave={() => setHover(null)} style={{ cursor: 'default' }}>
            <path d={s.path} fill={s.color} opacity={hover === s.i ? 1 : 0.85} stroke="#fff" strokeWidth="1.5" />
            {s.pct > 0.05 && (
              <text x={s.lx} y={s.ly} textAnchor="middle" fontSize="9" fill="#475569" fontWeight="600">
                {(s.pct * 100).toFixed(1)}%
              </text>
            )}
          </g>
        ))}
      </svg>
      <div className="flex flex-col gap-1 min-w-0">
        {items.map((it, i) => (
          <div key={i} className="flex items-center gap-1.5 text-xs text-slate-600 truncate">
            <span className="w-2.5 h-2.5 rounded-sm flex-shrink-0" style={{ background: COLORS[i % COLORS.length] }} />
            <span className="truncate">{it.label}</span>
            <span className="text-slate-400 ml-auto flex-shrink-0">{fmt(it.value)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ── TableChart ── */
function TableChartViz({ data }: { data: Record<string, unknown>[] }) {
  if (!data || data.length === 0) return <p className="text-slate-400 text-sm">无数据</p>;
  const cols = Object.keys(data[0]);
  return (
    <div className="overflow-auto max-h-[220px] rounded-lg border border-slate-200">
      <table className="w-full text-xs">
        <thead className="bg-slate-50 sticky top-0">
          <tr>
            {cols.map(c => (
              <th key={c} className="px-3 py-2 text-left font-medium text-slate-600 border-b border-slate-200 whitespace-nowrap">{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.map((row, ri) => (
            <tr key={ri} className="hover:bg-slate-50 transition-colors">
              {cols.map(c => (
                <td key={c} className="px-3 py-1.5 text-slate-700 border-b border-slate-100 whitespace-nowrap">{String(row[c] ?? '')}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ── MetricDetailModal ── */
function MetricDetailModal({ metric, onClose }: { metric: Metric; onClose: () => void }) {
  const [tab, setTab] = useState<'info' | 'sql'>('info');
  const [copied, setCopied] = useState(false);

  const handleCopy = (text: string) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl mx-4 overflow-hidden" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-indigo-50 flex items-center justify-center">
              {metric.chartType === 'number' ? <Hash className="w-4 h-4 text-indigo-600" /> :
               metric.chartType === 'bar' ? <BarChart3 className="w-4 h-4 text-indigo-600" /> :
               metric.chartType === 'line' ? <TrendingUp className="w-4 h-4 text-indigo-600" /> :
               metric.chartType === 'pie' ? <PieChart className="w-4 h-4 text-indigo-600" /> :
               <Table2 className="w-4 h-4 text-indigo-600" />}
            </div>
            <div>
              <h2 className="text-base font-semibold text-slate-900">{metric.name}</h2>
              <p className="text-[11px] text-slate-500">{metric.chartType} · {new Date(metric.createdAt).toLocaleString('zh-CN')}</p>
            </div>
          </div>
          <button onClick={onClose} className="p-1 rounded text-slate-400 hover:text-slate-600 hover:bg-slate-100 cursor-pointer transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Tabs */}
        <div className="px-6 border-b border-slate-100 flex gap-0">
          {([{ key: 'info' as const, label: '指标信息', icon: BarChart3 }, { key: 'sql' as const, label: 'SQL', icon: Code2 }]).map(t => {
            const Icon = t.icon;
            const active = tab === t.key;
            return (
              <button key={t.key} onClick={() => setTab(t.key)}
                className={`flex items-center gap-1.5 px-4 py-2.5 text-xs font-medium border-b-2 transition-colors cursor-pointer ${
                  active ? 'border-indigo-600 text-indigo-700' : 'border-transparent text-slate-500 hover:text-slate-700 hover:border-slate-300'
                }`}>
                <Icon className="w-3.5 h-3.5" />{t.label}
              </button>
            );
          })}
        </div>

        {/* Content */}
        <div className="overflow-auto px-6 py-4" style={{ maxHeight: '55vh' }}>
          {tab === 'info' && (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div className="bg-slate-50 rounded-lg p-3 border border-slate-200">
                  <p className="text-[10px] text-slate-400 mb-1">指标名称</p>
                  <p className="text-sm font-medium text-slate-800">{metric.name}</p>
                </div>
                <div className="bg-slate-50 rounded-lg p-3 border border-slate-200">
                  <p className="text-[10px] text-slate-400 mb-1">图表类型</p>
                  <p className="text-sm font-medium text-slate-800">{metric.chartType}</p>
                </div>
                <div className="bg-slate-50 rounded-lg p-3 border border-slate-200">
                  <p className="text-[10px] text-slate-400 mb-1">创建时间</p>
                  <p className="text-sm text-slate-800">{new Date(metric.createdAt).toLocaleString('zh-CN')}</p>
                </div>
                <div className="bg-slate-50 rounded-lg p-3 border border-slate-200">
                  <p className="text-[10px] text-slate-400 mb-1">数据行数</p>
                  <p className="text-sm text-slate-800">{metric.data?.length ?? 0} 行</p>
                </div>
              </div>
              {metric.definition && (
                <div className="bg-slate-50 rounded-lg p-3 border border-slate-200">
                  <p className="text-[10px] text-slate-400 mb-1">定义描述</p>
                  <p className="text-sm text-slate-700">{metric.definition}</p>
                </div>
              )}
              {metric.tables && metric.tables.length > 0 && (
                <div className="bg-slate-50 rounded-lg p-3 border border-slate-200">
                  <p className="text-[10px] text-slate-400 mb-1.5">涉及表</p>
                  <div className="flex flex-wrap gap-1.5">
                    {metric.tables.map(t => (
                      <span key={t} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] bg-white border border-slate-200 text-slate-600">
                        <Table2 className="w-3 h-3 text-amber-500" />{t}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
          {tab === 'sql' && (
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <p className="text-xs font-medium text-slate-600">查询 SQL</p>
                <button onClick={() => handleCopy(metric.sql)} className="p-1 rounded text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 transition-colors cursor-pointer" title="复制">
                  {copied ? <Check className="w-3.5 h-3.5 text-emerald-500" /> : <Copy className="w-3.5 h-3.5" />}
                </button>
              </div>
              <pre className="bg-slate-900 rounded-lg p-3 text-[11px] text-slate-200 font-mono overflow-x-auto whitespace-pre-wrap leading-relaxed">{metric.sql}</pre>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ── Chart type icon helper ── */
const CHART_ICONS: Record<string, typeof Hash> = {
  number: Hash, bar: BarChart3, line: TrendingUp, pie: PieChart, table: Table2,
};

const SWITCHABLE_TYPES: { key: ChartType; icon: typeof Hash; label: string }[] = [
  { key: 'number', icon: Hash, label: '数值' },
  { key: 'bar', icon: BarChart3, label: '柱状图' },
  { key: 'line', icon: TrendingUp, label: '折线图' },
  { key: 'pie', icon: PieChart, label: '饼图' },
  { key: 'table', icon: Table2, label: '表格' },
];

/* ── Main MetricCard ── */
export function isCompactMetric(_chartType: string): boolean {
  return false;
}

export default function MetricCard({ metric, onDelete, onRefresh }: {
  metric: Metric;
  onDelete: (id: string) => void;
  onRefresh: (id: string) => void;
}) {
  const [showDetail, setShowDetail] = useState(false);
  const [showSwitch, setShowSwitch] = useState(false);
  const updateMetric = useMetricStore(s => s.updateMetric);
  const Icon = CHART_ICONS[metric.chartType] || BarChart3;

  const handleSwitchChart = (ct: ChartType) => {
    if (ct !== metric.chartType) {
      updateMetric(metric.id, { chartType: ct });
    }
    setShowSwitch(false);
  };

  const renderChart = () => {
    const data = metric.data;
    if (!data || data.length === 0) return <p className="text-slate-400 text-sm text-center py-4">无数据</p>;
    switch (metric.chartType) {
      case 'number': return <NumberChart data={data} definition={metric.definition} />;
      case 'bar': return <BarChartViz data={data} />;
      case 'line': return <LineChartViz data={data} />;
      case 'pie': return <PieChartViz data={data} />;
      case 'table': return <TableChartViz data={data} />;
      default: return <TableChartViz data={data} />;
    }
  };

  return (
    <>
      <div
        className="bg-white rounded-xl border border-slate-200 shadow-sm hover:shadow-md transition-all cursor-pointer group relative"
        onClick={() => setShowDetail(true)}
      >
        {/* card header */}
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-slate-100">
          <div className="flex items-center gap-2 min-w-0">
            <Icon className="w-3.5 h-3.5 text-indigo-500 flex-shrink-0" />
            <span className="text-xs font-medium text-slate-800 truncate">{metric.name}</span>
          </div>
          <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity" onClick={e => e.stopPropagation()}>
            {/* chart type switcher toggle */}
            <button
              onClick={(e) => { e.stopPropagation(); setShowSwitch(v => !v); }}
              className="p-1 rounded text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 transition-colors cursor-pointer"
              title="切换图表类型"
            >
              <BarChart3 className="w-3 h-3" />
            </button>
            <button onClick={() => onRefresh(metric.id)} className="p-1 rounded text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 transition-colors cursor-pointer" title="刷新">
              <RefreshCw className="w-3 h-3" />
            </button>
            <button onClick={() => onDelete(metric.id)} className="p-1 rounded text-slate-400 hover:text-red-600 hover:bg-red-50 transition-colors cursor-pointer" title="删除">
              <Trash2 className="w-3 h-3" />
            </button>
          </div>
        </div>
        {/* chart type switcher dropdown */}
        {showSwitch && (
          <div
            className="absolute right-3 top-10 z-20 bg-white rounded-lg shadow-lg border border-slate-200 py-1 min-w-[100px]"
            onClick={e => e.stopPropagation()}
          >
            {SWITCHABLE_TYPES.map(t => {
              const TIcon = t.icon;
              const active = metric.chartType === t.key;
              return (
                <button
                  key={t.key}
                  onClick={() => handleSwitchChart(t.key)}
                  className={`w-full flex items-center gap-2 px-3 py-1.5 text-xs transition-colors cursor-pointer ${
                    active ? 'bg-indigo-50 text-indigo-700 font-medium' : 'text-slate-600 hover:bg-slate-50'
                  }`}
                >
                  <TIcon className="w-3 h-3" />
                  {t.label}
                </button>
              );
            })}
          </div>
        )}
        {/* chart body */}
        <div className={metric.chartType === 'number' ? 'px-4 py-2' : 'px-4 py-3'}>
          {renderChart()}
        </div>
      </div>
      {showDetail && <MetricDetailModal metric={metric} onClose={() => setShowDetail(false)} />}
    </>
  );
}
