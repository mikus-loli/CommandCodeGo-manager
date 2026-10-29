// 用量统计(Phase 3.3):范围选择 + 每日柱线图 + 模型 token 堆叠图 + 按模型/key 下钻明细表。
import { useEffect, useMemo, useState } from 'react';
import { Activity, Coins, Database, Zap } from 'lucide-react';
import { fetchUsage, type UsageRow } from '../api';
import {
  Card, CardBody, CardHeader, EChart, echartsBase, EmptyState, Loading, vgrad,
  StatCard, Table, Tabs, Td, Th, toast, themeColor, useTheme, useNarrow, fmtInt, fmtK,
} from '../ui';

// ── 工具 ──────────────────────────────────────────────────
function fmtDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function rangeOf(n: number): { from: string; to: string } {
  const to = new Date();
  const from = new Date();
  from.setDate(from.getDate() - n);
  return { from: fmtDate(from), to: fmtDate(to) };
}
const totalTokens = (r: UsageRow) => (r.input_tokens ?? 0) + (r.output_tokens ?? 0) + (r.cached_tokens ?? 0);

const RANGE_TABS = [
  { id: '7', label: '最近 7 天' },
  { id: '30', label: '最近 30 天' },
  { id: '90', label: '最近 90 天' },
];

type SortKey = 'dim' | 'requests' | 'input_tokens' | 'cached_tokens' | 'output_tokens' | 'total';
type SortDir = 'asc' | 'desc';

// 可排序表头(Th 不透传 onClick,内嵌按钮)
function SortTh({ label, k, sortKey, sortDir, onSort, className = '' }: {
  label: string; k: SortKey; sortKey: SortKey; sortDir: SortDir;
  onSort: (k: SortKey) => void; className?: string;
}) {
  const active = k === sortKey;
  return (
    <Th className={className}>
      <button onClick={() => onSort(k)} className={`inline-flex min-h-[24px] items-center gap-1 transition-colors ${active ? 'text-accent' : 'hover:text-txt'}`}>
        {label}
        <span className="text-[9px] leading-none">{active ? (sortDir === 'asc' ? '▲' : '▼') : ''}</span>
      </button>
    </Th>
  );
}

export function Usage() {
  const [range, setRange] = useState('30');
  const [tab, setTab] = useState<'model' | 'key'>('model');
  const [dayRows, setDayRows] = useState<UsageRow[] | null>(null);
  const [modelRows, setModelRows] = useState<UsageRow[] | null>(null);
  const [keyRows, setKeyRows] = useState<UsageRow[] | null>(null);
  const [failMsg, setFailMsg] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>('requests');
  const [sortDir, setSortDir] = useState<SortDir>('desc');

  const { from, to } = useMemo(() => rangeOf(Number(range)), [range]);

  // 天/模型维度随范围加载(主图、次图、汇总卡共用)
  useEffect(() => {
    let alive = true;
    setDayRows(null); setModelRows(null); setFailMsg(null);
    (async () => {
      try {
        const [d, m] = await Promise.all([
          fetchUsage(`?from=${from}&to=${to}&groupBy=day`),
          fetchUsage(`?from=${from}&to=${to}&groupBy=model`),
        ]);
        if (!alive) return;
        setDayRows(d.rows ?? []); setModelRows(m.rows ?? []);
      } catch (e) {
        if (!alive) return;
        setDayRows([]); setModelRows([]);
        setFailMsg((e as Error).message || '加载失败');
        toast('err', `加载用量数据失败:${(e as Error).message}`);
      }
    })();
    return () => { alive = false; };
  }, [from, to]);

  // key 维度按需加载(下钻表切到「按 key」时)
  useEffect(() => {
    if (tab !== 'key') return;
    let alive = true;
    setKeyRows(null);
    (async () => {
      try {
        const d = await fetchUsage(`?from=${from}&to=${to}&groupBy=key`);
        if (alive) setKeyRows(d.rows ?? []);
      } catch (e) {
        if (!alive) return;
        setKeyRows([]);
        setFailMsg((e as Error).message || '加载失败');
        toast('err', `加载用量明细失败:${(e as Error).message}`);
      }
    })();
    return () => { alive = false; };
  }, [from, to, tab]);

  // ── 主图:每日 请求数(柱)+ 输入/输出 tokens(线),缺数据的天补 0;配色随主题 ──
  const [theme] = useTheme();
  const narrow = useNarrow();
  const dayOption = useMemo(() => {
    if (!dayRows) return null;
    const C = {
      accent: themeColor('--color-accent'), brand2: themeColor('--color-brand2'),
      violet: themeColor('--color-violet'),
      txt2: themeColor('--color-txt2'), ok: themeColor('--color-ok'),
      txt3: themeColor('--color-txt3'), line: themeColor('--color-line'), line2: themeColor('--color-line2'),
    };
    const base = echartsBase(narrow);
    const byDay = new Map<string, UsageRow>();
    for (const r of dayRows) if (r.day) byDay.set(r.day, r);
    const labels: string[] = [], reqs: number[] = [], ins: number[] = [], outs: number[] = [];
    const d = new Date(`${from}T00:00:00`);
    while (fmtDate(d) <= to) {
      const key = fmtDate(d);
      const r = byDay.get(key);
      labels.push(key.slice(5));
      reqs.push(r?.requests ?? 0);
      ins.push(r?.input_tokens ?? 0);
      outs.push(r?.output_tokens ?? 0);
      d.setDate(d.getDate() + 1);
    }
    return {
      ...base,
      // 手机上省掉右轴刻度,把宽度让给绘图区(tokens 走 tooltip)
      grid: { ...base.grid, top: narrow ? 52 : 56, right: narrow ? 10 : 64 },
      legend: { data: ['请求数', '输入 tokens', '输出 tokens'], top: 4, right: narrow ? 4 : 8, itemWidth: narrow ? 10 : 14, itemGap: narrow ? 8 : 10, textStyle: { color: C.txt2, fontSize: narrow ? 10 : 12 } },
      xAxis: {
        type: 'category', data: labels,
        axisLine: { lineStyle: { color: C.line2 } }, axisTick: { show: false },
        axisLabel: { color: C.txt2, fontSize: 11 },
      },
      yAxis: [
        {
          type: 'value',
          axisLabel: { color: C.txt2, fontSize: 11 }, splitLine: { lineStyle: { color: C.line } },
        },
        {
          type: 'value',
          axisLabel: { show: !narrow, color: C.txt2, fontSize: 11 }, splitLine: { show: false },
        },
      ],
      series: [
        {
          name: '请求数', type: 'bar', yAxisIndex: 0, data: reqs,
          itemStyle: { color: vgrad(C.accent + 'cc', C.accent + '22'), borderRadius: [4, 4, 0, 0] }, barMaxWidth: 18,
        },
        {
          name: '输入 tokens', type: 'line', yAxisIndex: 1, data: ins,
          smooth: true, showSymbol: false, lineStyle: { color: C.violet, width: 2.5 },
          areaStyle: { color: vgrad(C.violet + '30', C.violet + '05') }, itemStyle: { color: C.violet },
        },
        {
          name: '输出 tokens', type: 'line', yAxisIndex: 1, data: outs,
          smooth: true, showSymbol: false, lineStyle: { color: C.brand2, width: 2.5 },
          areaStyle: { color: vgrad(C.brand2 + '30', C.brand2 + '05') }, itemStyle: { color: C.brand2 },
        },
      ],
    };
  }, [dayRows, from, to, theme, narrow]);

  // ── 次图:模型维度 输入/缓存/输出 三段堆叠横向条形图(按总量取 Top 10) ──
  const modelOption = useMemo(() => {
    if (!modelRows) return null;
    const C = {
      accent: themeColor('--color-accent'), brand2: themeColor('--color-brand2'),
      violet: themeColor('--color-violet'), warn: themeColor('--color-warn'), ok: themeColor('--color-ok'),
      txt2: themeColor('--color-txt2'), line: themeColor('--color-line'), line2: themeColor('--color-line2'),
    };
    const base = echartsBase(narrow);
    const top = [...modelRows].sort((a, b) => totalTokens(b) - totalTokens(a)).slice(0, 10);
    return {
      ...base,
      // 窄屏把左侧模型名列从 150px 收到 96px,并截断超长模型名
      grid: { ...base.grid, top: narrow ? 46 : 52, left: narrow ? 96 : 150 },
      legend: { data: ['输入', '缓存', '输出'], top: 4, right: narrow ? 4 : 8, itemWidth: narrow ? 10 : 14, itemGap: narrow ? 8 : 10, textStyle: { color: C.txt2, fontSize: narrow ? 10 : 12 } },
      xAxis: {
        type: 'value',
        axisLabel: { color: C.txt2, fontSize: 11 }, splitLine: { lineStyle: { color: C.line } },
      },
      yAxis: {
        type: 'category', inverse: true, data: top.map(r => r.model ?? 'unknown'),
        axisLine: { lineStyle: { color: C.line2 } }, axisTick: { show: false },
        axisLabel: { color: C.txt2, fontSize: narrow ? 10 : 11, width: narrow ? 84 : 140, overflow: 'truncate' },
      },
      series: [
        { name: '输入', type: 'bar', stack: 'tokens', data: top.map(r => r.input_tokens ?? 0), itemStyle: { color: C.accent }, barMaxWidth: 14 },
        { name: '缓存', type: 'bar', stack: 'tokens', data: top.map(r => r.cached_tokens ?? 0), itemStyle: { color: C.violet } },
        { name: '输出', type: 'bar', stack: 'tokens', data: top.map(r => r.output_tokens ?? 0), itemStyle: { color: C.brand2 } },
      ],
    };
  }, [modelRows, theme, narrow]);

  // ── 范围内汇总(模型/天维度任一可用即可求和) ──
  const stats = useMemo(() => {
    let requests = 0, input = 0, output = 0, cached = 0;
    for (const r of modelRows ?? dayRows ?? []) {
      requests += r.requests ?? 0;
      input += r.input_tokens ?? 0;
      output += r.output_tokens ?? 0;
      cached += r.cached_tokens ?? 0;
    }
    return { requests, input, output, cached };
  }, [modelRows, dayRows]);
  const statsLoading = !modelRows && !dayRows;

  // ── 下钻表(按模型 / 按 key),前端排序 ──
  const tableRows = tab === 'model' ? modelRows : keyRows;
  const sortedRows = useMemo(() => {
    const rows = (tableRows ?? []).map(r => ({
      r,
      dim: tab === 'model' ? (r.model ?? 'unknown') : (r.key_name ?? '(direct)'),
      total: totalTokens(r),
    }));
    const dir = sortDir === 'asc' ? 1 : -1;
    rows.sort((a, b) => {
      if (sortKey === 'dim') return a.dim.localeCompare(b.dim) * dir;
      if (sortKey === 'total') return (a.total - b.total) * dir;
      return (((a.r[sortKey] ?? 0) - (b.r[sortKey] ?? 0)) * dir);
    });
    return rows;
  }, [tableRows, tab, sortKey, sortDir]);

  const toggleSort = (k: SortKey) => {
    if (k === sortKey) setSortDir(d => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortKey(k); setSortDir(k === 'dim' ? 'asc' : 'desc'); }
  };

  const emptyOrFailed = (failed: boolean) => failed
    ? <EmptyState title="用量数据加载失败" hint={failMsg ?? '请确认代理服务可达后重试。'} />
    : <EmptyState title="暂无用量数据" hint="该时间范围内没有任何代理请求记录。" />;

  return (
    <div className="space-y-4 md:space-y-5">
      {/* ── 范围内汇总 ── */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 md:gap-4">
        <StatCard label="总请求" value={statsLoading ? '…' : fmtInt(stats.requests)} icon={<Activity size={18} />} />
        <StatCard label="输入 Tokens" value={statsLoading ? '…' : fmtK(stats.input)} icon={<Coins size={18} />} />
        <StatCard label="输出 Tokens" value={statsLoading ? '…' : fmtK(stats.output)} icon={<Zap size={18} />} />
        <StatCard label="缓存 Tokens" value={statsLoading ? '…' : fmtK(stats.cached)} icon={<Database size={18} />} />
      </div>

      {/* ── 主图:每日请求与 tokens ── */}
      <Card>
        <CardHeader
          title="每日请求与 Tokens"
          extra={
            <div className="flex w-full max-w-full items-center gap-3 sm:w-auto">
              <span className="tnum hidden text-xs text-txt3 sm:inline">{from} ~ {to}</span>
              <Tabs items={RANGE_TABS} value={range} onChange={setRange} />
            </div>
          } />
        <CardBody className="p-3 md:p-4">
          {dayRows === null ? (
            <Loading>加载用量数据…</Loading>
          ) : dayRows.length === 0 ? (
            emptyOrFailed(!!failMsg)
          ) : (
            dayOption && <EChart option={dayOption} className="h-56 sm:h-72" />
          )}
        </CardBody>
      </Card>

      {/* ── 次图:模型 token 构成 ── */}
      <Card>
        <CardHeader title="模型 Token 构成" extra={<span className="text-[11px] text-txt3 md:text-xs">按总 tokens 取 Top 10<span className="hidden sm:inline"> · 输入 / 缓存 / 输出</span></span>} />
        <CardBody className="p-3 md:p-4">
          {modelRows === null ? (
            <Loading>加载模型维度数据…</Loading>
          ) : modelRows.length === 0 ? (
            emptyOrFailed(!!failMsg)
          ) : (
            modelOption && <EChart option={modelOption} className="h-64 sm:h-80" />
          )}
        </CardBody>
      </Card>

      {/* ── 下钻表 ── */}
      <Card>
        <CardHeader
          title="用量明细"
          extra={<Tabs items={[{ id: 'model', label: '按模型' }, { id: 'key', label: '按 key' }]} value={tab} onChange={id => setTab(id as 'model' | 'key')} />} />
        {tableRows === null ? (
          <Loading>加载明细…</Loading>
        ) : sortedRows.length === 0 ? (
          emptyOrFailed(!!failMsg)
        ) : (
          <Table>
            <thead>
              <tr>
                <SortTh label={tab === 'model' ? '模型' : 'Key'} k="dim" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                <SortTh label="请求数" k="requests" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} className="text-right" />
                <SortTh label="输入 tokens" k="input_tokens" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} className="text-right" />
                <SortTh label="缓存 tokens" k="cached_tokens" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} className="hidden text-right md:table-cell" />
                <SortTh label="输出 tokens" k="output_tokens" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} className="hidden text-right md:table-cell" />
                <SortTh label="合计 tokens" k="total" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} className="text-right" />
              </tr>
            </thead>
            <tbody>
              {sortedRows.map(({ r, dim, total }) => (
                <tr key={`${dim}-${r.key_id ?? ''}`} className="transition-colors hover:bg-panel2/60">
                  <Td className="max-w-40 truncate font-mono text-xs md:max-w-64">{dim}</Td>
                  <Td className="tnum text-right text-xs">{fmtInt(r.requests)}</Td>
                  <Td className="tnum text-right text-xs">{fmtInt(r.input_tokens)}</Td>
                  <Td className="hidden tnum text-right text-xs md:table-cell">{fmtInt(r.cached_tokens)}</Td>
                  <Td className="hidden tnum text-right text-xs md:table-cell">{fmtInt(r.output_tokens)}</Td>
                  <Td className="tnum text-right text-xs font-medium text-txt">{fmtInt(total)}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </div>
  );
}
