import { useCallback, useEffect, useState } from 'react';
import { useI18n } from '../context/I18nContext';
import Icon from './ui/Icon';
import Toast from './ui/Toast';
import api from '../api/client';

/**
 * Duplicate cleanup.
 *
 * Once bank/card sync is connected it re-imports purchases the user already logged by
 * hand, so the same money appears twice. This removes the hand-logged copy.
 *
 * Two things drive the layout:
 *
 *  1. The realistic case is ~100 pairs, not five. Listing them all inline buried the rest
 *     of Settings under a wall of rows nobody reads. So the default view is a summary and
 *     one button; the pairs live behind "Review individually" for anyone who wants them.
 *     Bulk-approving is the honest default — the server proved each pair, and the numbers
 *     needed to sanity-check the action are all on screen.
 *
 *  2. Nothing here means anything until sync has imported something, so the whole card
 *     stays hidden until then rather than showing an empty state in everyone's Settings.
 */

const fmt = (n) => `₪${Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const shortDate = (d) => new Date(d).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });

/** One hand-logged row beside the imported transaction that now covers it. */
function PairRow({ row, checked, onToggle, t }) {
  return (
    <label
      className="row"
      style={{
        gap: 10, alignItems: 'flex-start', padding: '8px 0',
        borderTop: '1px solid var(--line)', cursor: 'pointer',
        opacity: checked ? 1 : 0.45, transition: 'opacity .15s',
      }}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={onToggle}
        style={{ marginTop: 3, width: 14, height: 14, flexShrink: 0, accentColor: 'var(--rose)' }}
      />
      <div className="stack" style={{ gap: 2, minWidth: 0, flex: 1 }}>
        <div className="row" style={{ gap: 8, fontSize: 12.5 }}>
          <span className="muted-2" style={{ minWidth: 48 }}>{shortDate(row.date)}</span>
          <span dir="ltr" style={{ fontWeight: 500 }}>{fmt(row.amount)}</span>
          <span className="muted" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {row.description || t('cleanup_no_description')}
          </span>
        </div>
        {/* The evidence it is safe to go. */}
        <div className="row" style={{ gap: 8, fontSize: 12 }}>
          <span className="muted-2" style={{ minWidth: 48 }}>↔ {shortDate(row.match.date)}</span>
          <span className="muted-2" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {row.match.description}
          </span>
          {row.match.account && (
            <span className="muted-2" style={{ fontSize: 11, opacity: 0.7 }}>·{row.match.account}</span>
          )}
        </div>
      </div>
    </label>
  );
}

function Section({ titleKey, data, selected, toggle, toggleAll, t }) {
  if (data.matched_count === 0) return null;
  const allOn = data.matched.every((r) => selected.has(r.id));

  return (
    <div style={{ marginTop: 14 }}>
      <div className="between" style={{ marginBottom: 2 }}>
        <span style={{ fontWeight: 600, fontSize: 12.5 }}>
          {t(titleKey)} <span className="muted-2">({data.matched_count})</span>
        </span>
        <button className="btn ghost" style={{ height: 24, fontSize: 11.5 }} onClick={() => toggleAll(!allOn)}>
          {allOn ? t('cleanup_deselect_all') : t('cleanup_select_all')}
        </button>
      </div>
      {data.matched.map((row) => (
        <PairRow key={row.id} row={row} checked={selected.has(row.id)} onToggle={() => toggle(row.id)} t={t} />
      ))}
    </div>
  );
}

/** One number and its label. */
function Stat({ value, label, tone }) {
  return (
    <div className="stack" style={{ gap: 1, minWidth: 0 }}>
      <span dir="ltr" style={{ fontSize: 19, fontWeight: 600, color: tone || 'var(--text-1)', lineHeight: 1.2 }}>
        {value}
      </span>
      <span className="muted-2" style={{ fontSize: 11.5 }}>{label}</span>
    </div>
  );
}

export default function DuplicateCleanupCard() {
  const { t } = useI18n();
  const [scan, setScan] = useState(null);
  const [archive, setArchive] = useState(null);
  const [selExp, setSelExp] = useState(new Set());
  const [selInc, setSelInc] = useState(new Set());
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState('');
  const [expanded, setExpanded] = useState(false);
  const [showKept, setShowKept] = useState(false);
  const [lastBatch, setLastBatch] = useState(null);

  // State is only touched in the promise callbacks, never synchronously — the initial
  // effect below would otherwise trigger a cascading render.
  const load = useCallback(() => {
    return Promise.all([api.get('/cleanup/duplicates'), api.get('/cleanup/archive')])
      .then(([dupes, arch]) => {
        setScan(dupes.data);
        setArchive(arch.data);
        // Everything the server proved is a duplicate starts ticked — that is the
        // expected action. Unticking is the exception, so it costs the click.
        setSelExp(new Set(dupes.data.expenses.matched.map((r) => r.id)));
        setSelInc(new Set(dupes.data.income.matched.map((r) => r.id)));
      })
      .catch(() => setToast(t('cleanup_err_scan')))
      .finally(() => setBusy(false));
  }, [t]);

  const rescan = () => { setBusy(true); load(); };

  useEffect(() => { load(); }, [load]);

  const toggleIn = (setter) => (id) => setter((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const confirm = async () => {
    setBusy(true);
    try {
      const res = await api.post('/cleanup/duplicates', {
        expense_ids: [...selExp],
        income_ids: [...selInc],
      });
      setLastBatch(res.data.batch_id);
      setExpanded(false);
      setToast(
        t('cleanup_toast_removed')
          .replace('{count}', res.data.removed_expenses + res.data.removed_income)
          .replace('{days}', res.data.restore_window_days)
      );
      await load();
    } catch (err) {
      setToast(err.response?.data?.error || t('cleanup_err_remove'));
    } finally {
      setBusy(false);
    }
  };

  const restore = async (batch_id) => {
    setBusy(true);
    try {
      const res = await api.post('/cleanup/restore', { batch_id });
      setToast(t('cleanup_toast_restored').replace('{count}', res.data.restored_expenses + res.data.restored_income));
      setLastBatch(null);
      await load();
    } catch {
      setToast(t('cleanup_err_restore'));
    } finally {
      setBusy(false);
    }
  };

  const archivedCount = (archive?.expenses.length || 0) + (archive?.income.length || 0);

  // Hidden entirely until sync has imported something — before that there is nothing to
  // compare against, and an empty state would sit in every user's Settings forever.
  if (!scan || !scan.has_synced_data) return null;

  const matchedCount = scan.expenses.matched_count + scan.income.matched_count;
  const matchedAmount = scan.expenses.matched_amount + scan.income.matched_amount;
  const keptCount = scan.expenses.unmatched_count + scan.income.unmatched_count;
  const keptRows = [...scan.expenses.unmatched_sample, ...scan.income.unmatched_sample];
  const totalSelected = selExp.size + selInc.size;

  // Nothing to remove and nothing to put back: stay out of the way.
  if (matchedCount === 0 && archivedCount === 0) return null;

  return (
    <div className="card card-pad-lg" style={{ marginBottom: 20 }}>
      <div className="between" style={{ marginBottom: 4 }}>
        <h3 className="h2">{t('cleanup_title')}</h3>
        <button className="btn ghost" style={{ height: 30 }} onClick={rescan} disabled={busy}>
          <Icon name="refresh-cw" size={13} /> {t('cleanup_rescan')}
        </button>
      </div>
      <div className="muted" style={{ fontSize: 13, marginBottom: 14 }}>{t('cleanup_sub')}</div>

      {matchedCount === 0 ? (
        <div className="muted-2" style={{ fontSize: 12.5 }}>{t('cleanup_all_clear')}</div>
      ) : (
        <>
          {/* The summary is the whole story for most people. */}
          <div
            className="row"
            style={{
              gap: 26, flexWrap: 'wrap', padding: '14px 16px', borderRadius: 10,
              background: 'var(--hover-bg-2)', marginBottom: 12,
            }}
          >
            <Stat value={matchedCount} label={t('cleanup_stat_duplicates')} tone="var(--rose)" />
            <Stat value={fmt(matchedAmount)} label={t('cleanup_stat_amount')} />
            <Stat
              value={`${scan.expenses.matched_count} · ${scan.income.matched_count}`}
              label={t('cleanup_stat_split')}
            />
            <Stat value={keptCount} label={t('cleanup_stat_kept')} tone="var(--emerald)" />
          </div>

          {/* Saying what is KEPT is as important as what goes: it is the proof that cash
              and Bit were not swept up by a date range. */}
          {keptCount > 0 && (
            <div style={{ marginBottom: 12 }}>
              <button
                className="btn ghost"
                style={{ height: 26, fontSize: 12, paddingInline: 0 }}
                onClick={() => setShowKept((v) => !v)}
              >
                <Icon name={showKept ? 'chevron-down' : 'chevron-right'} size={13} />
                {t('cleanup_kept_toggle').replace('{count}', keptCount)}
              </button>
              {showKept && (
                <div className="stack" style={{ gap: 3, marginTop: 6, paddingInlineStart: 18 }}>
                  <span className="muted-2" style={{ fontSize: 11.5 }}>{t('cleanup_kept_hint')}</span>
                  {keptRows.map((r) => (
                    <span key={`${r.id}-${r.amount}`} className="muted-2" style={{ fontSize: 11.5 }}>
                      • {shortDate(r.date)} <span dir="ltr">{fmt(r.amount)}</span> — {r.description || t('cleanup_no_description')}
                    </span>
                  ))}
                  {keptCount > keptRows.length && (
                    <span className="muted-2" style={{ fontSize: 11.5 }}>
                      {t('cleanup_kept_more').replace('{count}', keptCount - keptRows.length)}
                    </span>
                  )}
                </div>
              )}
            </div>
          )}

          <div className="row" style={{ gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <button
              className="btn primary"
              style={{ background: 'var(--rose)', borderColor: 'var(--rose)' }}
              disabled={busy || totalSelected === 0}
              onClick={confirm}
            >
              <Icon name="trash-2" size={13} /> {t('cleanup_remove_btn').replace('{count}', totalSelected)}
            </button>
            <button className="btn" onClick={() => setExpanded((v) => !v)} disabled={busy}>
              <Icon name={expanded ? 'chevron-up' : 'sliders-horizontal'} size={13} />
              {expanded ? t('cleanup_review_hide') : t('cleanup_review_show')}
            </button>
            <span className="muted-2" style={{ fontSize: 12 }}>
              {t('cleanup_undo_hint').replace('{days}', scan.restore_window_days)}
            </span>
          </div>

          {/* Every pair, for anyone who wants to check or keep one. Scrolls in place so a
              hundred rows cannot push the rest of Settings off the screen. */}
          {expanded && (
            <div
              style={{
                marginTop: 6, maxHeight: 420, overflowY: 'auto',
                paddingInlineEnd: 6, borderRadius: 8,
              }}
            >
              <Section
                titleKey="cleanup_section_expenses"
                data={scan.expenses}
                selected={selExp}
                toggle={toggleIn(setSelExp)}
                toggleAll={(on) => setSelExp(on ? new Set(scan.expenses.matched.map((r) => r.id)) : new Set())}
                t={t}
              />
              <Section
                titleKey="cleanup_section_income"
                data={scan.income}
                selected={selInc}
                toggle={toggleIn(setSelInc)}
                toggleAll={(on) => setSelInc(on ? new Set(scan.income.matched.map((r) => r.id)) : new Set())}
                t={t}
              />
            </div>
          )}
        </>
      )}

      {/* Undo. Offered right after a run, and kept for the whole window. */}
      {archivedCount > 0 && (
        <div
          className="between"
          style={{
            marginTop: 16, padding: '12px 14px', borderRadius: 8,
            background: 'var(--hover-bg-2)', flexWrap: 'wrap', gap: 10,
          }}
        >
          <div className="stack" style={{ gap: 2 }}>
            <span style={{ fontSize: 13, fontWeight: 500 }}>
              {t('cleanup_archive_title').replace('{count}', archivedCount)}
            </span>
            <span className="muted-2" style={{ fontSize: 12 }}>
              {t('cleanup_archive_hint').replace('{days}', archive.restore_window_days)}
            </span>
          </div>
          <button
            className="btn"
            disabled={busy}
            onClick={() => restore(lastBatch || archive.expenses[0]?.batch_id || archive.income[0]?.batch_id)}
          >
            <Icon name="rotate-ccw" size={13} /> {t('cleanup_restore_btn')}
          </button>
        </div>
      )}

      <Toast msg={toast} onDone={() => setToast('')} />
    </div>
  );
}
