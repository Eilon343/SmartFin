import { useEffect, useState } from 'react';
import api from '../api/client';

function currentMonth() {
  return new Date().toISOString().slice(0, 7);
}

export default function Expenses() {
  const [expenses, setExpenses] = useState([]);
  const [month, setMonth] = useState(currentMonth());
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    api.get(`/expenses?month=${month}`)
      .then((r) => setExpenses(r.data))
      .finally(() => setLoading(false));
  }, [month]);

  return (
    <div style={styles.page}>
      <div style={styles.toolbar}>
        <h2 style={styles.title}>Expenses</h2>
        <input
          type="month"
          value={month}
          onChange={(e) => setMonth(e.target.value)}
          style={styles.monthPicker}
        />
      </div>

      {loading ? (
        <p style={styles.empty}>Loading…</p>
      ) : expenses.length === 0 ? (
        <p style={styles.empty}>No expenses for {month}</p>
      ) : (
        <table style={styles.table}>
          <thead>
            <tr>
              {['Date', 'Description', 'Category', 'Amount', 'Source'].map((h) => (
                <th key={h} style={styles.th}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {expenses.map((e) => (
              <tr key={e.expense_id} style={styles.tr}>
                <td style={styles.td}>{e.created_at?.slice(0, 10)}</td>
                <td style={styles.td}>{e.description || '—'}</td>
                <td style={styles.td}>
                  <span style={styles.badge}>{e.category_name || 'Uncategorized'}</span>
                </td>
                <td style={{ ...styles.td, fontWeight: 600, color: '#38bdf8' }}>
                  {e.currency} {Number(e.amount).toFixed(2)}
                </td>
                <td style={styles.td}>
                  {e.source === 'apple_pay'
                    ? <span style={styles.applePayBadge}>􀣺 Apple Pay</span>
                    : <span style={styles.botBadge}>Bot</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

const styles = {
  page: { padding: '24px 32px', color: '#f1f5f9', fontFamily: 'sans-serif' },
  toolbar: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 },
  title: { margin: 0, fontSize: 20, fontWeight: 600, color: '#cbd5e1' },
  monthPicker: { padding: '6px 10px', borderRadius: 8, border: '1px solid #334155', background: '#1e293b', color: '#f1f5f9', fontSize: 14 },
  empty: { color: '#475569', textAlign: 'center', marginTop: 60 },
  table: { width: '100%', borderCollapse: 'collapse' },
  th: { textAlign: 'left', padding: '10px 14px', color: '#64748b', fontSize: 12, fontWeight: 600, textTransform: 'uppercase', borderBottom: '1px solid #1e293b' },
  tr: { borderBottom: '1px solid #1e293b' },
  td: { padding: '12px 14px', fontSize: 14, color: '#e2e8f0' },
  badge: { background: '#1e3a5f', color: '#93c5fd', padding: '3px 10px', borderRadius: 20, fontSize: 12 },
  applePayBadge: { background: '#1a1a1a', color: '#f5f5f7', padding: '3px 10px', borderRadius: 20, fontSize: 11, fontWeight: 600, letterSpacing: '-0.01em' },
  botBadge: { background: '#1e2230', color: '#5b6171', padding: '3px 10px', borderRadius: 20, fontSize: 11 },
};
