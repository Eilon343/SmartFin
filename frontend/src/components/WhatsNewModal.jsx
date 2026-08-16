import { useState } from 'react';
import { useI18n } from '../context/I18nContext';
import { markWhatsNewSeen } from '../lib/whatsNew';
import Icon from './ui/Icon';
import Modal from './ui/Modal';

/** The one-time tour shown after the bank-sync update lands. */

/**
 * Pages are ordered by what a user has to do, not by what is most impressive: connect the
 * bank, then the cards (the step people skip, and the one that decides whether their
 * spending is itemised), then what happens to their credentials — asked before it is
 * answered, otherwise — and only then cleanup, which is the consequence of the rest.
 */
const PAGES = [
  { icon: 'landmark',     key: 'intro',     accent: 'var(--indigo)' },
  { icon: 'link',         key: 'connect',   accent: 'var(--indigo)' },
  { icon: 'credit-card',  key: 'cards',     accent: 'var(--amber)' },
  { icon: 'shield-check', key: 'safe',      accent: 'var(--emerald)' },
  // Duplicates get two pages, not one. Telling someone their data is about to double
  // and how to clean it in a single breath reads as a warning attached to a chore.
  // Separating them lets the first page set the expectation calmly — this is normal,
  // nothing is lost — before the second shows it is already handled.
  { icon: 'copy',         key: 'dupeswhy',  accent: 'var(--amber)' },
  { icon: 'sparkles',     key: 'dupesfix',  accent: 'var(--emerald)' },
];

export default function WhatsNewModal({ open, onClose }) {
  const { t, lang } = useI18n();
  const [page, setPage] = useState(0);
  const rtl = lang === 'he';

  const last = page === PAGES.length - 1;
  const current = PAGES[page];

  // Rewinding on the way out rather than on the way in keeps this in an event handler.
  // Every exit — button, Escape, scrim — routes through here, so re-opening from
  // Settings always starts at page 1 instead of resuming a half-read tour.
  const finish = () => {
    markWhatsNewSeen();
    setPage(0);
    onClose();
  };

  return (
    <Modal open={open} onClose={finish}>
      <div className="stack" style={{ gap: 0, maxWidth: 440 }}>
        {/* Skip is always reachable — a tour you cannot leave is an obstacle. */}
        <div className="between" style={{ marginBottom: 4 }}>
          <span className="muted-2" style={{ fontSize: 11.5, letterSpacing: '0.04em', textTransform: 'uppercase' }}>
            {t('whatsnew_eyebrow')}
          </span>
          <button className="btn ghost icon" onClick={finish} aria-label={t('whatsnew_skip')}>
            <Icon name="x" size={16} />
          </button>
        </div>

        <div
          style={{
            width: 46, height: 46, borderRadius: 12, marginBottom: 14,
            background: 'var(--hover-bg-2)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}
        >
          <Icon name={current.icon} size={22} color={current.accent} />
        </div>

        <h3 className="h2" style={{ fontSize: 19, marginBottom: 8 }}>
          {t(`whatsnew_${current.key}_title`)}
        </h3>

        {/* Reserves height so the footer does not jump between pages, but only where
            there is room to spare — on a phone the copy is already several lines tall and
            a floor would just push the buttons off a short screen. */}
        <p
          className="muted whatsnew-body"
          style={{ fontSize: 13.5, lineHeight: 1.6, margin: 0, whiteSpace: 'pre-line' }}
        >
          {t(`whatsnew_${current.key}_body`)}
        </p>

        <div className="between whatsnew-footer" style={{ marginTop: 18, gap: 12, flexWrap: 'wrap' }}>
          <div className="row" style={{ gap: 6 }}>
            {PAGES.map((p, i) => (
              <button
                key={p.key}
                onClick={() => setPage(i)}
                aria-label={`${i + 1}`}
                aria-current={i === page}
                style={{
                  width: i === page ? 18 : 6, height: 6, borderRadius: 999, padding: 0,
                  border: 'none', cursor: 'pointer',
                  background: i === page ? 'var(--text-1)' : 'var(--line-2)',
                  transition: 'width .2s, background .2s',
                }}
              />
            ))}
          </div>

          <div className="row whatsnew-actions" style={{ gap: 8 }}>
            {page > 0 && (
              <button className="btn" onClick={() => setPage((p) => p - 1)}>
                <Icon name={rtl ? 'chevron-right' : 'chevron-left'} size={14} />
                {t('whatsnew_back')}
              </button>
            )}
            <button className="btn primary" onClick={() => (last ? finish() : setPage((p) => p + 1))}>
              {last ? t('whatsnew_done') : t('whatsnew_next')}
              {!last && <Icon name={rtl ? 'chevron-left' : 'chevron-right'} size={14} />}
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
