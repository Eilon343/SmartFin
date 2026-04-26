import { useEffect, useState } from 'react';
import { PieChart, Pie, Cell, Tooltip, Legend, LineChart, Line, XAxis, YAxis, CartesianGrid, ResponsiveContainer } from 'recharts';
import api from '../api/client';
import { useAuth } from '../context/AuthContext';

const COLORS = ['#38bdf8', '#818cf8', '#34d399', '#fb923c', '#f472b6', '#a78bfa', '#fbbf24', '#60a5fa'];

function currentMonth() {
  return new Date().toISOString().slice(0, 7);
}

export default function Dashboard() {
  const { logout } = useAuth();
  const [summary, setSummary] = useState(null);
  const [expenses, setExpenses] = useState([]);
  const [month, setMonth] = useState(currentMonth());
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    Promise.all([
      api.get(`/expenses/summary?month=${month}`),
      api.get(`/expenses?month=${month}`),
    ]).then(([s, e]) => {
      setSummary(s.data);
      setExpenses(e.data);
    }).finally(() => setLoading(false));
  }, [month]);

  const dailyData = buildDailyData(expenses, month);

  return (
    <div style={styles.page}>
      <header style={styles.header}>
        <h1 style={styles.logo}>SmartFin</h1>
        <div style={styles.headerRight}>
          <input
            type="month"
            value={month}
            onChange={(e) => setMonth(e.target.value)}
            style={styles.monthPicker}
          />
          <button onClick={logout} style={styles.logoutBtn}>Sign out</button>
        </div>
      </header>

      {loading ? (
        <p style={styles.loading}>Loading…</p>
      ) : (
        <>
          <div style={styles.statsRow}>
            <StatCard label="Total spent" value={`₪ ${Number(summary?.grand_total || 0).toFixed(2)}`} />
            <StatCard label="Categories" value={summary?.by_category?.length ?? 0} />
            <StatCard label="Transactions" value={expenses.length} />
          </div>

          <div style={styles.chartsRow}>
            <div style={styles.chartCard}>
              <h3 style={styles.chartTitle}>Spending by Category</h3>
              {summary?.by_category?.length ? (
                <ResponsiveContainer width="100%" height={260}>
                  <PieChart>
                    <Pie data={summary.by_category} dataKey="total" nameKey="category" cx="50%" cy="50%" outerRadius={90} label={({ category, percent }) => `${category} ${(percent * 100).toFixed(0)}%`}>
                      {summary.by_category.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
                    </Pie>
                    <Tooltip formatter={(v) => `₪ ${Number(v).toFixed(2)}`} />
                  </PieChart>
                </ResponsiveContainer>
              ) : <p style={styles.empty}>No data for this month</p>}
            </div>

            <div style={styles.chartCard}>
              <h3 style={styles.chartTitle}>Daily Burn Rate</h3>
              {dailyData.length ? (
                <ResponsiveContainer width="100%" height={260}>
                  <LineChart data={dailyData} margin={{ top: 5, right: 20, bottom: 5, left: 0 }}>
                    <CartesianGrid stroke="#334155" strokeDasharray="3 3" />
                    <XAxis dataKey="day" tick={{ fill: '#94a3b8', fontSize: 12 }} />
                    <YAxis tick={{ fill: '#94a3b8', fontSize: 12 }} />
                    <Tooltip formatter={(v) => `₪ ${Number(v).toFixed(2)}`} contentStyle={{ background: '#1e293b', border: '1px solid #334155' }} />
                    <Line type="monotone" dataKey="total" stroke="#38bdf8" strokeWidth={2} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              ) : <p style={styles.empty}>No data for this month</p>}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function StatCard({ label, value }) {
  return (
    <div style={styles.statCard}>
      <span style={styles.statValue}>{value}</span>
      <span style={styles.statLabel}>{label}</span>
    </div>
  );
}

function buildDailyData(expenses, month) {
  const map = {};
  expenses.forEach((e) => {
    const day = e.created_at?.slice(8, 10);
    if (!day) return;
    map[day] = (map[day] || 0) + Number(e.amount);
  });
  return Object.entries(map)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, total]) => ({ day: `${month}-${day}`.slice(5), total }));
}

const styles = {
  page: { minHeight: '100vh', background: '#0f172a', color: '#f1f5f9', fontFamily: 'sans-serif', padding: '0 0 40px' },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '20px 32px', borderBottom: '1px solid #1e293b' },
  logo: { color: '#38bdf8', margin: 0, fontSize: 22, fontWeight: 700 },
  headerRight: { display: 'flex', gap: 12, alignItems: 'center' },
  monthPicker: { padding: '6px 10px', borderRadius: 8, border: '1px solid #334155', background: '#1e293b', color: '#f1f5f9', fontSize: 14 },
  logoutBtn: { padding: '6px 14px', borderRadius: 8, border: '1px solid #334155', background: 'transparent', color: '#94a3b8', cursor: 'pointer', fontSize: 14 },
  loading: { textAlign: 'center', marginTop: 80, color: '#94a3b8' },
  statsRow: { display: 'flex', gap: 16, padding: '24px 32px 0' },
  statCard: { flex: 1, background: '#1e293b', borderRadius: 12, padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 4 },
  statValue: { fontSize: 28, fontWeight: 700, color: '#38bdf8' },
  statLabel: { fontSize: 13, color: '#94a3b8' },
  chartsRow: { display: 'flex', gap: 16, padding: '16px 32px 0', flexWrap: 'wrap' },
  chartCard: { flex: 1, minWidth: 300, background: '#1e293b', borderRadius: 12, padding: '20px 24px' },
  chartTitle: { margin: '0 0 16px', fontSize: 15, fontWeight: 600, color: '#cbd5e1' },
  empty: { color: '#475569', textAlign: 'center', marginTop: 60 },
};
