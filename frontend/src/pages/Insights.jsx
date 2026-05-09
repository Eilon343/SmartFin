import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import api from '../api/client';
import Icon from '../components/ui/Icon';
import PageHeader from '../components/ui/PageHeader';
import Sk from '../components/ui/Skeleton';
import Toast from '../components/ui/Toast';
import { useI18n } from '../context/I18nContext';

const CAT_COLORS = [
  '#f59e0b', '#60a5fa', '#a78bfa', '#f472b6', '#34d399', '#fb7185',
  '#22d3ee', '#94a3b8', '#facc15', '#818cf8', '#4ade80', '#f97316',
];
const CAT_ICONS = {
  food: 'utensils-crossed', groceries: 'utensils-crossed', restaurant: 'wine',
  transport: 'car', transit: 'car', home: 'house', housing: 'house',
  utilities: 'zap', leisure: 'wine', entertainment: 'tv',
  health: 'heart-pulse', medical: 'heart-pulse', shopping: 'shopping-bag',
  kids: 'baby', misc: 'package', other: 'package',
  clothing: 'shirt', education: 'graduation-cap', travel: 'plane',
  gym: 'dumbbell', sports: 'dumbbell', pets: 'paw-print',
};

function catIcon(name) {
  const key = name?.toLowerCase().replace(/[^a-z]/g, '');
  for (const [k, v] of Object.entries(CAT_ICONS)) if (key?.includes(k)) return v;
  return 'tag';
}
const catColor = (i) => CAT_COLORS[i % CAT_COLORS.length];

function fmt(n) {
  if (n == null || Number.isNaN(n)) return '—';
  return `‎₪${Math.round(n).toLocaleString('en-US')}‎`;
}
function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}
function getRecentMonths(num, lang) {
  const out = [];
  const now = new Date();
  let y = now.getFullYear(), m = now.getMonth();
  const locale = lang === 'he' ? 'he-IL' : 'en-US';
  for (let i = 0; i < num; i++) {
    const d = new Date(y, m, 1);
    const iso = `${y}-${String(m + 1).padStart(2, '0')}`;
    const label = d.toLocaleDateString(locale, { month: 'short' });
    const longLabel = d.toLocaleDateString(locale, { month: 'long', year: 'numeric' });
    out.push({ iso, label, longLabel });
    m--; if (m < 0) { m = 11; y--; }
  }
  return out;
}

/* ---------- Donut ---------- */
function DonutChart({ slices, activeId, onSelect, size = 220, stroke = 28 }) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const total = slices.reduce((s, x) => s + x.value, 0) || 1;
  const offsets = [];
  {
    let acc = 0;
    for (const s of slices) { offsets.push(acc); acc += s.value / total; }
  }
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ overflow: 'visible' }}>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--input-bg)" strokeWidth={stroke} />
      {slices.map((s, idx) => {
        const frac = s.value / total;
        const dash = c * frac;
        const gap = c - dash;
        const offset = -offsets[idx] * c;
        const isActive = activeId === s.id;
        const inactiveOpacity = activeId && !isActive ? 0.35 : 1;
        return (
          <circle key={s.id}
            cx={size / 2} cy={size / 2} r={r}
            fill="none" stroke={s.color} strokeWidth={isActive ? stroke + 4 : stroke}
            strokeDasharray={`${Math.max(0, dash - 2)} ${gap + 2}`}
            strokeDashoffset={offset}
            strokeLinecap="butt"
            transform={`rotate(-90 ${size / 2} ${size / 2})`}
            style={{
              cursor: 'pointer',
              opacity: inactiveOpacity,
              transition: 'opacity .2s, stroke-width .2s',
              filter: isActive ? `drop-shadow(0 0 8px ${s.color}66)` : 'none',
            }}
            onClick={() => onSelect(isActive ? null : s.id)}
          />
        );
      })}
    </svg>
  );
}

function ExpenseDonutCard({ data }) {
  const slices = useMemo(() => (data.by_category || [])
    .map((c, i) => ({ id: c.category_id, name: c.name, color: catColor(i), value: c.spent, prev: c.prev_spent }))
    .filter(s => s.value > 0)
    .sort((a, b) => b.value - a.value), [data]);

  const total = slices.reduce((s, x) => s + x.value, 0);
  const [active, setActive] = useState(null);
  useEffect(() => { setActive(null); }, [data.month]);
  const sel = active ? slices.find(s => s.id === active) : null;
  const delta = sel ? sel.value - sel.prev : null;
  const deltaPct = sel && sel.prev ? (delta / sel.prev) * 100 : null;

  return (
    <div className="card card-pad-lg">
      <div className="between" style={{ marginBottom: 14 }}>
        <div className="stack" style={{ gap: 4 }}>
          <h3 className="h2">Expense Distribution</h3>
          <span className="muted" style={{ fontSize: 12 }}>Click a slice to compare to previous month</span>
        </div>
        <span className="chip"><Icon name="pie-chart" size={11} /> {slices.length} categories</span>
      </div>

      <div className="ins-donut-grid">
        <div className="ins-donut" style={{ position: 'relative', display: 'flex', justifyContent: 'center', alignItems: 'center' }}>
          {slices.length === 0 ? (
            <div className="muted" style={{ fontSize: 13, padding: 40 }}>No spending data</div>
          ) : (
            <DonutChart slices={slices} activeId={active} onSelect={setActive} size={220} stroke={28} />
          )}
          {slices.length > 0 && (
            <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none' }}>
              <div className="stack" style={{ alignItems: 'center', gap: 2 }}>
                <span className="meta-label">{sel ? sel.name : 'Total'}</span>
                <div className="mono tnum ins-donut-center" style={{ fontSize: 26, fontWeight: 700, letterSpacing: '-0.02em' }} dir="ltr">
                  {fmt(sel ? sel.value : total)}
                </div>
                {sel ? (
                  deltaPct != null && (
                    <span className={`chip ${delta > 0 ? 'down' : 'up'}`} style={{ marginTop: 4 }}>
                      <Icon name={delta > 0 ? 'trending-up' : 'trending-down'} size={11} />
                      {delta > 0 ? '+' : ''}{deltaPct.toFixed(0)}% vs prev
                    </span>
                  )
                ) : (
                  <span className="muted" style={{ fontSize: 11.5 }}>spent this month</span>
                )}
              </div>
            </div>
          )}
        </div>

        <div className="stack" style={{ gap: 6, minWidth: 0 }}>
          {slices.map(s => {
            const p = total ? (s.value / total) * 100 : 0;
            const isActive = active === s.id;
            return (
              <button key={s.id}
                onClick={() => setActive(isActive ? null : s.id)}
                style={{
                  display: 'grid', gridTemplateColumns: '12px 1fr auto', gap: 10, alignItems: 'center',
                  padding: '8px 10px', borderRadius: 8,
                  background: isActive ? 'var(--hover-bg-2)' : 'transparent',
                  border: '1px solid ' + (isActive ? 'var(--line-2)' : 'transparent'),
                  cursor: 'pointer', textAlign: 'left',
                  color: 'inherit', font: 'inherit',
                  opacity: active && !isActive ? 0.55 : 1, transition: 'opacity .15s, background .15s',
                }}>
                <span className="dot" style={{ background: s.color, width: 10, height: 10 }} />
                <span style={{ fontSize: 13, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {s.name}
                </span>
                <span className="row" style={{ gap: 8 }}>
                  <span className="muted-2 mono" style={{ fontSize: 11 }}>{p.toFixed(0)}%</span>
                  <span className="mono tnum" style={{ fontSize: 12.5, fontWeight: 600 }} dir="ltr">{fmt(s.value)}</span>
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <style>{`
        .ins-donut-grid { display: grid; grid-template-columns: 240px 1fr; gap: 22px; align-items: center; }
        @media (max-width: 760px) { .ins-donut-grid { grid-template-columns: 1fr; } }
      `}</style>
    </div>
  );
}

/* ---------- Momentum ---------- */
function MomentumChart({ data }) {
  const target = data.budget_total > 0 ? data.budget_total : data.three_mo_avg_total;
  const cum = [];
  let running = 0;
  for (const v of data.daily) {
    if (v == null) cum.push(null);
    else { running += v; cum.push(running); }
  }

  const W = 720, H = 220, padL = 44, padR = 14, padT = 12, padB = 28;
  const innerW = W - padL - padR, innerH = H - padT - padB;
  const yMax = Math.max(target || 1, ...cum.filter(v => v != null), 1) * 1.05;
  const x = (i) => padL + (innerW * i) / Math.max(1, data.days_in_month - 1);
  const y = (v) => padT + innerH - (v / yMax) * innerH;

  const pts = cum.map((v, i) => v == null ? null : [x(i), y(v)]).filter(Boolean);
  const linePath = pts.map((p, i) => (i === 0 ? `M${p[0]},${p[1]}` : `L${p[0]},${p[1]}`)).join(' ');
  const areaPath = pts.length ? `${linePath} L${pts[pts.length - 1][0]},${y(0)} L${pts[0][0]},${y(0)} Z` : '';
  const idealEnd = [x(data.days_in_month - 1), y(target)];
  const idealStart = [x(0), y(0)];

  const [hover, setHover] = useState(null);
  const svgRef = useRef(null);
  const onMove = (e) => {
    if (!svgRef.current) return;
    const rect = svgRef.current.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
    const day = Math.round(((px - padL) / innerW) * (data.days_in_month - 1));
    const clamped = Math.max(0, Math.min(data.days_in_month - 1, day));
    if (cum[clamped] != null) setHover({ day: clamped, value: cum[clamped] });
    else setHover(null);
  };

  const todayValue = cum[data.today_day - 1] || 0;
  const idealAtToday = (target * (data.today_day - 1)) / Math.max(1, data.days_in_month - 1);
  const overUnder = todayValue - idealAtToday;
  const isOver = overUnder > 0;

  return (
    <div className="card card-pad-lg">
      <div className="between" style={{ marginBottom: 4 }}>
        <div className="stack" style={{ gap: 4 }}>
          <h3 className="h2">Daily Spending Momentum</h3>
          <span className="muted" style={{ fontSize: 12 }} dir="ltr">
            Cumulative spend vs. ideal pacing line ({fmt(target)} target)
          </span>
        </div>
        {target > 0 && (
          <span className={`chip ${isOver ? 'down' : 'up'}`}>
            <Icon name={isOver ? 'trending-up' : 'trending-down'} size={11} />
            {isOver ? 'Over' : 'Under'} pace by {fmt(Math.abs(overUnder))}
          </span>
        )}
      </div>

      <div style={{ marginTop: 12, position: 'relative' }}>
        <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} width="100%" height={H}
             preserveAspectRatio="none"
             onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
          <defs>
            <linearGradient id="mom-fill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--emerald)" stopOpacity="0.28" />
              <stop offset="100%" stopColor="var(--emerald)" stopOpacity="0" />
            </linearGradient>
          </defs>

          {[0, 0.25, 0.5, 0.75, 1].map((g, i) => (
            <g key={i}>
              <line x1={padL} x2={W - padR} y1={padT + innerH * (1 - g)} y2={padT + innerH * (1 - g)}
                    stroke="var(--row-divider, var(--line))" strokeWidth="1" />
              <text x={padL - 8} y={padT + innerH * (1 - g) + 3} textAnchor="end"
                    fontSize="10" fill="var(--text-3)">
                ₪{Math.round((yMax * g) / 1000)}k
              </text>
            </g>
          ))}

          {Array.from({ length: data.days_in_month }).map((_, i) => (
            (i % 5 === 0 || i === data.days_in_month - 1) && (
              <text key={i} x={x(i)} y={H - 8} textAnchor="middle"
                    fontSize="10" fill="var(--text-3)">{i + 1}</text>
            )
          ))}

          {target > 0 && (
            <>
              <line x1={idealStart[0]} y1={idealStart[1]} x2={idealEnd[0]} y2={idealEnd[1]}
                    stroke="var(--text-3)" strokeWidth="1.5" strokeDasharray="4 4" />
              <text x={idealEnd[0] - 8} y={idealEnd[1] - 6} textAnchor="end"
                    fontSize="10.5" fill="var(--text-3)">ideal pace</text>
            </>
          )}

          {areaPath && <path d={areaPath} fill="url(#mom-fill)" />}
          {linePath && <path d={linePath} fill="none" stroke="var(--emerald)" strokeWidth="2"
                             strokeLinecap="round" strokeLinejoin="round" />}

          {pts.length > 0 && (
            <g>
              <line x1={pts[pts.length - 1][0]} x2={pts[pts.length - 1][0]}
                    y1={padT} y2={padT + innerH}
                    stroke="var(--emerald)" strokeWidth="1" strokeDasharray="2 3" opacity="0.5" />
              <circle cx={pts[pts.length - 1][0]} cy={pts[pts.length - 1][1]} r="4.5"
                      fill="var(--emerald)" stroke="var(--card)" strokeWidth="2" />
            </g>
          )}

          {hover && cum[hover.day] != null && (
            <g>
              <line x1={x(hover.day)} x2={x(hover.day)} y1={padT} y2={padT + innerH}
                    stroke="var(--text-2)" strokeWidth="1" opacity="0.4" />
              <circle cx={x(hover.day)} cy={y(hover.value)} r="4"
                      fill="var(--card)" stroke="var(--emerald)" strokeWidth="2" />
            </g>
          )}
        </svg>

        {hover && (
          <div style={{
            position: 'absolute', top: 8, left: 0, pointerEvents: 'none',
            transform: `translateX(${(x(hover.day) / W) * 100}%) translateX(-50%)`,
            background: 'var(--card-2, var(--card))', border: '1px solid var(--line-2)',
            padding: '6px 10px', borderRadius: 8, fontSize: 11.5,
            boxShadow: '0 4px 12px rgba(0,0,0,0.08)', whiteSpace: 'nowrap',
          }}>
            <span className="muted-2">Day {hover.day + 1}</span>
            <span className="mono tnum" style={{ fontWeight: 700, marginLeft: 8 }} dir="ltr">
              {fmt(hover.value)}
            </span>
          </div>
        )}
      </div>

      <div className="legend" style={{ marginTop: 14, gap: 16 }}>
        <div><span className="dot" style={{ background: 'var(--emerald)' }} /> Cumulative spend</div>
        <div><span style={{ width: 14, height: 1.5, background: 'var(--text-3)', display: 'inline-block' }} /> Ideal pacing</div>
        <div className="muted" style={{ marginLeft: 'auto', fontSize: 12 }} dir="ltr">
          {fmt(todayValue)} of {fmt(target)} · day {data.today_day}/{data.days_in_month}
        </div>
      </div>
    </div>
  );
}

/* ---------- Trend bars ---------- */
function TrendBars({ data }) {
  const rows = (data.by_category || [])
    .filter(c => c.spent > 0 || c.three_mo_avg > 0)
    .map((c, i) => {
      const delta = c.spent - c.three_mo_avg;
      const deltaPct = c.three_mo_avg ? (delta / c.three_mo_avg) * 100 : (c.spent > 0 ? 100 : 0);
      return { ...c, color: catColor(i), icon: catIcon(c.name), delta, deltaPct };
    })
    .sort((a, b) => b.deltaPct - a.deltaPct);

  if (rows.length === 0) {
    return (
      <div className="card card-pad-lg">
        <h3 className="h2">Category Trends</h3>
        <div className="muted" style={{ marginTop: 16, fontSize: 13 }}>No data yet — log some expenses first.</div>
      </div>
    );
  }

  const maxAbs = Math.max(...rows.map(r => Math.abs(r.deltaPct)), 30);

  return (
    <div className="card card-pad-lg">
      <div className="between" style={{ marginBottom: 14 }}>
        <div className="stack" style={{ gap: 4 }}>
          <h3 className="h2">Category Trends</h3>
          <span className="muted" style={{ fontSize: 12 }}>vs. your 3-month average</span>
        </div>
        <div className="legend">
          <div><span className="dot" style={{ background: 'var(--rose)' }} /> trending up</div>
          <div><span className="dot" style={{ background: 'var(--emerald)' }} /> trending down</div>
        </div>
      </div>

      <div className="stack trend-list" style={{ gap: 10 }}>
        {rows.map(r => {
          const widthPct = (Math.abs(r.deltaPct) / maxAbs) * 50;
          const isUp = r.delta > 0;
          const barColor = isUp ? 'var(--rose)' : 'var(--emerald)';
          return (
            <div key={r.category_id} className="trend-row">
              <div className="trend-name row" style={{ gap: 10, minWidth: 0 }}>
                <div className="cat-icon" style={{ width: 28, height: 28, color: r.color }}>
                  <Icon name={r.icon} size={14} />
                </div>
                <span style={{ fontSize: 13, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {r.name}
                </span>
                <span className="trend-pct-mobile mono tnum" style={{ marginLeft: 'auto', fontSize: 11, fontWeight: 700, color: barColor }}>
                  {isUp ? '+' : ''}{r.deltaPct.toFixed(0)}%
                </span>
                <span className="trend-amt-mobile mono tnum" style={{ fontSize: 10.5, color: 'var(--text-3)' }} dir="ltr">
                  {fmt(r.spent)}
                </span>
              </div>
              <div className="trend-bar-wrap">
                <div className="trend-bar">
                  <div className="trend-bar-axis" />
                  <div style={{
                    position: 'absolute', top: 3, bottom: 3,
                    left: isUp ? '50%' : `${50 - widthPct}%`,
                    width: `${widthPct}%`,
                    background: barColor, opacity: 0.85,
                    borderRadius: isUp ? '0 4px 4px 0' : '4px 0 0 4px',
                    transition: 'width .8s cubic-bezier(.2,.8,.2,1)',
                  }} />
                  <span className="trend-pct-desktop mono tnum" style={{
                    position: 'absolute', top: '50%',
                    left: isUp ? `calc(50% + ${widthPct}% + 8px)` : `calc(${50 - widthPct}% - 8px)`,
                    transform: isUp ? 'translateY(-50%)' : 'translate(-100%, -50%)',
                    fontSize: 11, fontWeight: 600, color: barColor, whiteSpace: 'nowrap',
                  }}>
                    {isUp ? '+' : ''}{r.deltaPct.toFixed(0)}%
                  </span>
                </div>
              </div>
              <div className="trend-amt-desktop mono tnum" style={{ fontSize: 12.5, textAlign: 'right' }} dir="ltr">
                <span style={{ fontWeight: 600 }}>{fmt(r.spent)}</span>
                <span className="muted-2" style={{ fontSize: 11 }}> / {fmt(r.three_mo_avg)}</span>
              </div>
            </div>
          );
        })}
      </div>

      <style>{`
        .trend-row {
          display: grid;
          grid-template-columns: 160px 1fr 130px;
          gap: 14px;
          align-items: center;
        }
        .trend-bar { position: relative; height: 22px; background: var(--input-bg); border-radius: 6px; }
        .trend-bar-axis { position: absolute; left: 50%; top: 0; bottom: 0; width: 1px; background: var(--line-2); }
        .trend-pct-mobile, .trend-amt-mobile { display: none; }
        @media (max-width: 640px) {
          .trend-row {
            grid-template-columns: 1fr;
            gap: 6px;
          }
          .trend-bar { height: 6px; border-radius: 999px; }
          .trend-pct-desktop, .trend-amt-desktop { display: none; }
          .trend-pct-mobile, .trend-amt-mobile { display: inline; }
        }
      `}</style>
    </div>
  );
}

/* ---------- Smart insights ---------- */
function SmartInsights({ data }) {
  const totalSpent = data.total_spent;
  const avgTotal = data.three_mo_avg_total || 0;
  const dailyAvg = data.today_day > 0 ? totalSpent / data.today_day : 0;
  const projectedHitDay = avgTotal > 0 && dailyAvg > 0
    ? Math.min(data.days_in_month, data.today_day + Math.max(0, Math.ceil((avgTotal - totalSpent) / dailyAvg)))
    : null;

  const cats = (data.by_category || [])
    .map(c => ({ ...c, delta: c.three_mo_avg ? ((c.spent - c.three_mo_avg) / c.three_mo_avg) * 100 : 0 }))
    .filter(c => c.spent > 0)
    .sort((a, b) => b.spent - a.spent);
  const top = cats[0];
  const topPct = top && top.three_mo_avg ? ((top.spent - top.three_mo_avg) / top.three_mo_avg) * 100 : 0;

  const we = data.weekend_daily_avg || 0;
  const wd = data.weekday_daily_avg || 0;
  const wkndPct = wd > 0 ? ((we - wd) / wd) * 100 : 0;
  const isWkndHigher = wkndPct > 0;

  const cards = [];

  if (projectedHitDay) {
    cards.push({
      tone: 'amb', toneVar: 'amber', icon: 'flame', title: 'Burn Rate Alert',
      body: <>At your current pace, you'll reach your monthly average spend by the <strong>{ordinal(projectedHitDay)}</strong>. <span className="muted">Consider slowing down.</span></>,
      stat: <span className="mono tnum">day {projectedHitDay}</span>,
    });
  }

  if (top) {
    cards.push({
      tone: topPct > 0 ? 'down' : 'up', toneVar: topPct > 0 ? 'rose' : 'emerald',
      icon: catIcon(top.name), title: 'Top Category',
      body: (
        <>You've spent <strong dir="ltr">{fmt(top.spent)}</strong> on <strong>{top.name}</strong> this month
        {top.three_mo_avg > 0 && (
          <>, which is <strong style={{ color: topPct > 0 ? 'var(--rose)' : 'var(--emerald)' }}>
            {topPct > 0 ? '+' : ''}{topPct.toFixed(0)}%</strong> {topPct > 0 ? 'higher' : 'lower'} than usual</>
        )}.</>
      ),
      stat: <span className="mono tnum" dir="ltr">{fmt(top.spent)}</span>,
    });
  }

  if (we > 0 || wd > 0) {
    cards.push({
      tone: 'idg', toneVar: 'indigo', icon: 'calendar-days', title: 'Weekend vs. Weekday',
      body: (
        <>You spend <strong>{Math.abs(wkndPct).toFixed(0)}% {isWkndHigher ? 'more' : 'less'}</strong> on weekends than weekdays.{' '}
        <span className="muted" dir="ltr">({fmt(we)} vs {fmt(wd)} per day)</span></>
      ),
      stat: (
        <div className="row" style={{ gap: 4 }}>
          <span className="mono tnum" style={{ fontSize: 11 }} dir="ltr">WD {fmt(wd)}</span>
          <span className="muted-2">·</span>
          <span className="mono tnum" style={{ fontSize: 11, color: 'var(--indigo)' }} dir="ltr">WE {fmt(we)}</span>
        </div>
      ),
    });
  }

  if (cards.length === 0) {
    return <div className="card card-pad muted" style={{ fontSize: 13 }}>Not enough data this month yet.</div>;
  }

  return (
    <div className="grid grid-3">
      {cards.map((c, i) => (
        <div key={i} className="card card-pad ins-card"
             style={{ display: 'flex', flexDirection: 'column', gap: 12, animationDelay: `${i * 70}ms` }}>
          <div className="between">
            <div className="row" style={{ gap: 10 }}>
              <div className="cat-icon" style={{
                width: 34, height: 34,
                background: `var(--${c.toneVar}-soft)`,
                color: `var(--${c.toneVar})`,
              }}>
                <Icon name={c.icon} size={16} />
              </div>
              <div className="stack">
                <span style={{ fontSize: 13, fontWeight: 600 }}>{c.title}</span>
                <span className={`chip ${c.tone}`} style={{ alignSelf: 'flex-start', marginTop: 2 }}>
                  <Icon name="sparkles" size={10} /> insight
                </span>
              </div>
            </div>
            <div style={{ fontSize: 12, fontWeight: 600 }}>{c.stat}</div>
          </div>
          <p style={{ margin: 0, fontSize: 13.5, lineHeight: 1.55, color: 'var(--text-1)' }}>{c.body}</p>
        </div>
      ))}
    </div>
  );
}

/* ---------- Export menu ---------- */
function ExportMenu({ onExport }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return;
    const onClick = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  const opts = [
    { id: 'pdf', icon: 'file-text', label: 'Monthly PDF report', sub: 'Charts + insights' },
    { id: 'xlsx', icon: 'file-spreadsheet', label: 'Excel (.xlsx)', sub: 'Raw transactions' },
    { id: 'csv', icon: 'file', label: 'CSV', sub: 'For spreadsheets' },
  ];

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button className="btn primary" onClick={() => setOpen(o => !o)}>
        <Icon name="download" size={14} />
        <span className="ins-export-label-long">Download report</span>
        <span className="ins-export-label-short">Report</span>
        <Icon name="chevron-down" size={12} style={{ marginLeft: 2 }} />
      </button>
      {open && (
        <div style={{
          position: 'absolute', top: 'calc(100% + 6px)', right: 0,
          background: 'var(--card)', border: '1px solid var(--line-2)',
          borderRadius: 12, boxShadow: '0 12px 32px rgba(0,0,0,0.12)', zIndex: 20,
          minWidth: 220, padding: 6,
        }}>
          {opts.map(o => (
            <button key={o.id}
              onClick={() => { onExport(o.id); setOpen(false); }}
              style={{
                display: 'grid', gridTemplateColumns: '20px 1fr', gap: 12, alignItems: 'center',
                padding: '10px 12px', borderRadius: 8, width: '100%',
                background: 'transparent', border: 0, cursor: 'pointer',
                color: 'var(--text-1)', textAlign: 'left',
              }}
              onMouseEnter={(e) => e.currentTarget.style.background = 'var(--hover-bg)'}
              onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}>
              <Icon name={o.icon} size={15} color="var(--text-2)" />
              <div className="stack">
                <span style={{ fontSize: 13, fontWeight: 500 }}>{o.label}</span>
                <span className="muted-2" style={{ fontSize: 11 }}>{o.sub}</span>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/* ---------- Page ---------- */
export default function Insights() {
  const { lang } = useI18n();
  const months = useMemo(() => getRecentMonths(4, lang), [lang]);
  const [month, setMonth] = useState(months[0].iso);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState('');
  const abortRef = useRef(null);

  const load = useCallback(() => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    api.get(`/insights?month=${month}`, { signal: controller.signal })
      .then(r => { if (!controller.signal.aborted) setData(r.data); })
      .catch(err => { if (!controller.signal.aborted && err.code !== 'ERR_CANCELED') console.error(err); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
  }, [month]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    window.addEventListener('smartfin:reload', load);
    return () => window.removeEventListener('smartfin:reload', load);
  }, [load]);

  const onExport = (kind) => {
    const sel = months.find(m => m.iso === month);
    setToast(`Generating ${kind.toUpperCase()} report for ${sel?.longLabel || month}…`);
  };

  const sel = months.find(m => m.iso === month);

  return (
    <div className="view-enter ins-page">
      <PageHeader
        title="Financial Insights"
        sub={`Deep spending analytics for ${sel?.longLabel || month}`}
        actions={
          <>
            <div className="seg" role="tablist" aria-label="Select month">
              {months.map(m => (
                <button key={m.iso} className={month === m.iso ? 'on' : ''} onClick={() => setMonth(m.iso)}>
                  {m.label}
                </button>
              ))}
            </div>
            <ExportMenu onExport={onExport} />
          </>
        }
      />

      {loading || !data ? (
        <div className="stack" style={{ gap: 18 }}>
          <div className="grid ins-row-1" style={{ display: 'grid', gridTemplateColumns: '1fr 1.2fr', gap: 18 }}>
            <Sk height={300} radius={14} />
            <Sk height={300} radius={14} />
          </div>
          <Sk height={320} radius={14} />
          <div className="grid grid-3" style={{ gap: 18 }}>
            <Sk height={140} radius={14} /><Sk height={140} radius={14} /><Sk height={140} radius={14} />
          </div>
        </div>
      ) : (
        <div className="ins-stack" style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
          <div className="grid ins-row-1" style={{ display: 'grid', gridTemplateColumns: '1fr 1.2fr', gap: 18 }}>
            <div className="ins-anim" style={{ animationDelay: '0ms' }}>
              <ExpenseDonutCard data={data} />
            </div>
            <div className="ins-anim" style={{ animationDelay: '70ms' }}>
              <MomentumChart data={data} />
            </div>
          </div>

          <div className="ins-anim" style={{ animationDelay: '140ms' }}>
            <TrendBars data={data} />
          </div>

          <div className="ins-anim" style={{ animationDelay: '210ms' }}>
            <div className="between" style={{ marginBottom: 12 }}>
              <h3 className="h2" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Icon name="sparkles" size={15} color="var(--indigo)" /> Smart Insights
              </h3>
              <span className="muted-2" style={{ fontSize: 11.5 }}>
                generated {new Date().toLocaleString('en-US', { hour: 'numeric', minute: '2-digit' })}
              </span>
            </div>
            <SmartInsights data={data} />
          </div>
        </div>
      )}

      <Toast msg={toast} onDone={() => setToast('')} />

      <style>{`
        .ins-page .ins-anim { animation: insRise .45s cubic-bezier(.2,.8,.2,1) both; }
        @keyframes insRise { from { opacity: 0; transform: translateY(14px); } to { opacity: 1; transform: translateY(0); } }
        .ins-card { animation: insRise .4s cubic-bezier(.2,.8,.2,1) both; }
        @media (max-width: 980px) { .ins-row-1 { grid-template-columns: 1fr !important; } }
        @media (max-width: 640px) {
          .ins-page .seg { flex: 1 1 100%; display: flex; }
          .ins-page .seg button { flex: 1; }
          .ins-page .ins-export-label-long { display: none; }
          .ins-page .ins-export-label-short { display: inline; }
          .ins-page .ins-donut svg { width: 172px !important; height: 172px !important; }
          .ins-page .ins-donut-center { font-size: 22px !important; }
          .ins-page .card.card-pad-lg { padding: 16px !important; }
        }
        .ins-page .ins-export-label-short { display: none; }
      `}</style>
    </div>
  );
}
