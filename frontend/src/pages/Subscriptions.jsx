import { useEffect, useState } from 'react';
import api from '../api/client';
import Icon from '../components/ui/Icon';
import PageHeader from '../components/ui/PageHeader';

function fmt(n, dp = 0) {
  return '₪' + n.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
}

function ordinal(d) {
  const s = ['th', 'st', 'nd', 'rd'], v = d % 100;
  return d + (s[(v - 20) % 10] || s[v] || s[0]);
}

const SUB_ICONS_MAP = {
  spotify: 'music-2', apple: 'apple', netflix: 'clapperboard', youtube: 'youtube',
  icloud: 'cloud', google: 'cloud', dropbox: 'cloud', notion: 'notebook-pen',
  gym: 'dumbbell', fitness: 'dumbbell', domain: 'globe', hosting: 'server',
  phone: 'smartphone', mobile: 'smartphone', amazon: 'shopping-bag',
  microsoft: 'laptop', adobe: 'pen-tool', github: 'code',
};

function subIcon(name) {
  const key = name?.toLowerCase().replace(/[^a-z]/g, '');
  for (const [k, v] of Object.entries(SUB_ICONS_MAP)) {
    if (key?.includes(k)) return v;
  }
  return 'repeat';
}

export default function Subscriptions() {
  const [subs, setSubs] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.get('/subscriptions').then(r => setSubs(r.data)).finally(() => setLoading(false));
  }, []);

  const monthlyTotal = subs.reduce((s, x) => s + x.amount, 0);
  const annualized = monthlyTotal * 12;
  const sorted = [...subs].sort((a, b) => a.day_of_month - b.day_of_month);

  return (
    <div className="view-enter">
      <PageHeader title="Subscriptions" sub="Recurring charges across all sources" />

      <div className="grid grid-3" style={{ marginBottom: 20 }}>
        <div className="card card-pad-lg">
          <span className="meta-label">Monthly burn</span>
          <div className="big-num" style={{ fontSize: 36, marginTop: 8 }}>
            <span className="ccy" style={{ fontSize: 20 }}>₪</span>{monthlyTotal.toFixed(2)}
          </div>
          <span className="muted" style={{ fontSize: 12 }}>{subs.length} active subscriptions</span>
        </div>
        <div className="card card-pad-lg">
          <span className="meta-label">Annualized</span>
          <div className="big-num" style={{ fontSize: 36, marginTop: 8 }}>
            <span className="ccy" style={{ fontSize: 20 }}>₪</span>{annualized.toFixed(0)}
          </div>
          <span className="chip idg" style={{ marginTop: 6 }}>
            <Icon name="repeat" size={11} /> projected
          </span>
        </div>
        <div className="card card-pad-lg">
          <span className="meta-label">Avg per subscription</span>
          <div className="big-num" style={{ fontSize: 36, marginTop: 8 }}>
            <span className="ccy" style={{ fontSize: 20 }}>₪</span>
            {subs.length > 0 ? (monthlyTotal / subs.length).toFixed(2) : '0.00'}
          </div>
          <span className="muted" style={{ fontSize: 12 }}>per month</span>
        </div>
      </div>

      <div className="card" style={{ overflow: 'hidden' }}>
        <div className="between" style={{ padding: '18px 22px' }}>
          <h3 className="h2">All subscriptions</h3>
        </div>
        {loading ? (
          <div style={{ padding: '24px 22px', color: 'var(--text-3)', fontSize: 13 }}>Loading…</div>
        ) : sorted.length === 0 ? (
          <div style={{ padding: '24px 22px', color: 'var(--text-3)', fontSize: 13 }}>
            No subscriptions found. Add them via the Telegram bot.
          </div>
        ) : (
          <div style={{ padding: '0 22px 14px' }}>
            {sorted.map(s => (
              <div key={s.subscription_id} className="sub-row">
                <div style={{
                  width: 36, height: 36, borderRadius: 9,
                  background: 'var(--hover-bg-2)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  color: 'var(--text-1)',
                }}>
                  <Icon name={subIcon(s.name)} size={16} />
                </div>
                <div className="stack">
                  <span style={{ fontWeight: 500, fontSize: 13.5 }}>{s.name}</span>
                  <span className="muted-2" style={{ fontSize: 11 }}>
                    Monthly · next on the {ordinal(s.day_of_month)}
                    {s.category ? ` · ${s.category}` : ''}
                  </span>
                </div>
                <span className="mono tnum" style={{ fontSize: 13 }}>
                  {fmt(s.amount, s.amount % 1 ? 2 : 0)}
                </span>
                <span className="chip up" style={{ fontSize: 10 }}>active</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
