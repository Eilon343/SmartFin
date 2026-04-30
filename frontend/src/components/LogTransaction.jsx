import { useState, useEffect, useRef } from 'react';
import api from '../api/client';
import Icon from './ui/Icon';
import BottomSheet from './ui/BottomSheet';

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
  for (const [k, v] of Object.entries(CAT_ICONS)) {
    if (key?.includes(k)) return v;
  }
  return 'tag';
}

const CAT_COLORS = [
  '#f59e0b','#60a5fa','#a78bfa','#f472b6','#34d399','#fb7185',
  '#22d3ee','#94a3b8','#facc15','#818cf8','#4ade80','#f97316',
];

export default function LogTransaction({ open, onClose, onSaved }) {
  const [tab, setTab] = useState('expense');
  const [amount, setAmount] = useState('');
  const [editingAmount, setEditingAmount] = useState(false);
  const [description, setDescription] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [isVirtual, setIsVirtual] = useState(false);
  const [categories, setCategories] = useState([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const amountRef = useRef(null);

  useEffect(() => {
    if (open) {
      setTab('expense');
      setAmount('');
      setDescription('');
      setCategoryId('');
      setIsVirtual(false);
      setError('');
      setEditingAmount(false);
      api.get('/categories').then(r => setCategories(r.data)).catch(() => {});
    }
  }, [open]);

  useEffect(() => {
    if (editingAmount && amountRef.current) amountRef.current.focus();
  }, [editingAmount]);

  async function handleSave() {
    const amt = parseFloat(amount);
    if (!amt || amt <= 0) { setError('Enter a valid amount.'); return; }
    setSaving(true);
    setError('');
    try {
      if (tab === 'expense') {
        await api.post('/expenses', {
          amount: amt,
          currency: 'ILS',
          description: description.trim() || undefined,
          category_id: categoryId || undefined,
          source: 'web',
          is_virtual: isVirtual,
        });
      } else {
        await api.post('/income', {
          amount: amt,
          currency: 'ILS',
          source: description.trim() || 'Income',
          type: 'variable',
          month: new Date().getFullYear() + '-' + String(new Date().getMonth() + 1).padStart(2, '0'),
        });
      }
      onSaved?.();
      onClose();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to save.');
    } finally {
      setSaving(false);
    }
  }

  const displayAmount = amount ? `₪${parseFloat(amount).toLocaleString('en-US', { maximumFractionDigits: 0 })}` : '₪0';

  return (
    <BottomSheet open={open} onClose={onClose}>
      <div style={{ padding: '20px 20px 8px', borderBottom: '1px solid var(--line)' }}>
        <div className="between">
          <span style={{ fontWeight: 700, fontSize: 17 }}>Log a transaction</span>
          <button className="btn ghost icon" onClick={onClose}><Icon name="x" size={18} /></button>
        </div>
        <div className="seg" style={{ marginTop: 16, width: '100%' }}>
          <button className={tab === 'expense' ? 'on' : ''} onClick={() => setTab('expense')}
            style={{ flex: 1, height: 36, fontSize: 14 }}>
            <Icon name="arrow-up" size={13} /> Expense
          </button>
          <button className={tab === 'income' ? 'on' : ''} onClick={() => setTab('income')}
            style={{ flex: 1, height: 36, fontSize: 14 }}>
            <Icon name="arrow-down" size={13} /> Income
          </button>
        </div>
      </div>

      <div style={{ padding: '24px 20px 0' }}>
        <div style={{ textAlign: 'center', marginBottom: 24 }}
             onClick={() => setEditingAmount(true)}>
          {editingAmount ? (
            <input
              ref={amountRef}
              type="number"
              min="0"
              step="1"
              value={amount}
              onChange={e => setAmount(e.target.value)}
              onBlur={() => setEditingAmount(false)}
              style={{
                fontSize: 48, fontWeight: 700, letterSpacing: -2, textAlign: 'center',
                background: 'transparent', border: 'none', outline: 'none',
                color: 'var(--text-0)', width: '100%',
                fontFamily: 'JetBrains Mono, monospace',
              }}
            />
          ) : (
            <>
              <div style={{
                fontSize: 48, fontWeight: 700, letterSpacing: -2,
                color: tab === 'expense' ? 'var(--text-0)' : 'var(--emerald)',
                fontFamily: 'JetBrains Mono, monospace', cursor: 'text',
              }}>
                {tab === 'expense' ? '−' : '+'}{displayAmount}
              </div>
              <div className="muted-2" style={{ fontSize: 12, marginTop: 4 }}>tap to edit</div>
            </>
          )}
        </div>

        <div className="field" style={{ marginBottom: 16 }}>
          <label>Description</label>
          <input className="input" style={{ height: 44 }}
            placeholder={tab === 'expense' ? 'e.g. Shufersal — weekly run' : 'e.g. Salary, Freelance'}
            value={description}
            onChange={e => setDescription(e.target.value)}
          />
        </div>

        {tab === 'expense' && categories.length > 0 && (
          <div style={{ marginBottom: 16 }}>
            <div className="meta-label" style={{ marginBottom: 8 }}>Category</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {categories.slice(0, 8).map((c, i) => (
                <button
                  key={c.category_id}
                  onClick={() => setCategoryId(categoryId === String(c.category_id) ? '' : String(c.category_id))}
                  style={{
                    display: 'inline-flex', alignItems: 'center', gap: 6,
                    height: 36, padding: '0 12px', borderRadius: 999,
                    background: categoryId === String(c.category_id) ? CAT_COLORS[i % CAT_COLORS.length] + '33' : 'var(--hover-bg-2)',
                    border: `1.5px solid ${categoryId === String(c.category_id) ? CAT_COLORS[i % CAT_COLORS.length] : 'var(--line-2)'}`,
                    color: categoryId === String(c.category_id) ? CAT_COLORS[i % CAT_COLORS.length] : 'var(--text-1)',
                    font: '500 13px Inter, sans-serif', cursor: 'pointer',
                    transition: 'all .15s',
                  }}
                >
                  <Icon name={catIcon(c.name)} size={13} />
                  {c.name}
                </button>
              ))}
            </div>
          </div>
        )}

        {tab === 'expense' && (
          <label className="row" style={{ gap: 10, cursor: 'pointer', marginBottom: 16, padding: '12px 0', borderTop: '1px solid var(--line)' }} onClick={() => setIsVirtual(v => !v)}>
            <div style={{
              width: 44, height: 24, borderRadius: 999, flexShrink: 0,
              background: isVirtual ? 'var(--indigo)' : 'var(--track)',
              position: 'relative', transition: 'background .2s', cursor: 'pointer',
            }}>
              <div style={{
                position: 'absolute', top: 3, left: isVirtual ? 23 : 3,
                width: 18, height: 18, borderRadius: '50%', background: '#fff',
                transition: 'left .2s',
              }} />
            </div>
              <div style={{
                position: 'absolute', top: 3, left: isVirtual ? 23 : 3,
                width: 18, height: 18, borderRadius: '50%', background: '#fff',
                transition: 'left .2s',
              }} />
            </div>
            <div className="stack" style={{ gap: 2 }}>
              <span style={{ fontSize: 13, fontWeight: 500 }}>Mark as virtual expense</span>
              <span className="muted-2" style={{ fontSize: 11 }}>Tracked but doesn't reduce real spending</span>
            </div>
          </label>
        )}

        {error && (
          <div style={{ color: 'var(--rose)', fontSize: 13, marginBottom: 12 }}>{error}</div>
        )}
      </div>

      <div style={{ padding: '8px 20px 28px' }}>
        <button
          className="btn primary"
          style={{ width: '100%', height: 52, fontSize: 16, borderRadius: 14, justifyContent: 'center' }}
          disabled={saving}
          onClick={handleSave}
        >
          <Icon name="check" size={16} />
          {saving ? 'Saving…' : 'Save transaction'}
        </button>
      </div>
    </BottomSheet>
  );
}
