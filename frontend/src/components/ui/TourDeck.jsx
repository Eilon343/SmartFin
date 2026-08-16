import { useRef, useState } from 'react';
import { useI18n } from '../../context/I18nContext';
import Icon from './Icon';
import Modal from './Modal';

/**
 * The paged card both in-app tours are built from: what's-new and the first-run welcome.
 *
 * Extracted rather than copied so the two cannot drift apart — "looks like the what's new
 * modal" stops being true the first time one of them is restyled alone. Everything
 * specific to a tour arrives as props; this file owns only the shell and the navigation.
 *
 * Copy is looked up as `${prefix}_${page.key}_title` / `_body`, so a tour is defined by a
 * page list plus matching i18n keys and nothing else.
 */

// How far a horizontal drag must travel before it counts as a swipe (px), and how much
// more horizontal than vertical it must be. The ratio is what stops a diagonal thumb
// scroll from flipping the page out from under someone who is reading.
const SWIPE_MIN_DISTANCE = 45;
const SWIPE_RATIO = 1.2;

export default function TourDeck({ open, pages, prefix, eyebrow, onFinish }) {
  const { t, lang } = useI18n();
  const [page, setPage] = useState(0);
  // -1 / 1, so the incoming panel animates from the side the reader is moving toward.
  const [dir, setDir] = useState(1);
  const touch = useRef(null);
  const rtl = lang === 'he';

  const last = page === pages.length - 1;
  const current = pages[page];

  const goTo = (next) => {
    if (next < 0 || next > pages.length - 1 || next === page) return;
    setDir(next > page ? 1 : -1);
    setPage(next);
  };

  // Rewinding on the way out rather than on the way in keeps this in an event handler.
  // Every exit — button, Escape, scrim — routes through here, so re-opening always starts
  // at page 1 instead of resuming a half-read tour.
  const finish = () => {
    setPage(0);
    setDir(1);
    onFinish();
  };

  const onTouchStart = (e) => {
    const p = e.touches[0];
    touch.current = { x: p.clientX, y: p.clientY };
  };

  const onTouchEnd = (e) => {
    if (!touch.current) return;
    const p = e.changedTouches[0];
    const dx = p.clientX - touch.current.x;
    const dy = p.clientY - touch.current.y;
    touch.current = null;

    if (Math.abs(dx) < SWIPE_MIN_DISTANCE) return;
    // A mostly-vertical drag is someone scrolling the body copy, not changing page.
    if (Math.abs(dx) < Math.abs(dy) * SWIPE_RATIO) return;

    // In Hebrew the pages advance right-to-left, so the gesture mirrors with the layout.
    const forward = rtl ? dx > 0 : dx < 0;
    goTo(page + (forward ? 1 : -1));
  };

  return (
    <Modal open={open} onClose={finish}>
      <div
        className="stack"
        style={{ gap: 0, maxWidth: 440, touchAction: 'pan-y' }}
        onTouchStart={onTouchStart}
        onTouchEnd={onTouchEnd}
      >
        {/* Skip is always reachable — a tour you cannot leave is an obstacle. */}
        <div className="between" style={{ marginBottom: 4 }}>
          <span className="muted-2" style={{ fontSize: 11.5, letterSpacing: '0.04em', textTransform: 'uppercase' }}>
            {eyebrow}
          </span>
          <button className="btn ghost icon" onClick={finish} aria-label={t('whatsnew_skip')}>
            <Icon name="x" size={16} />
          </button>
        </div>

        {/* Re-keyed per page so the panel remounts and replays the slide-in. */}
        <div key={page} className={dir > 0 ? 'tour-panel-next' : 'tour-panel-prev'}>
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
            {t(`${prefix}_${current.key}_title`)}
          </h3>

          {/* Reserves height so the footer does not jump between pages, but only where
              there is room to spare — on a phone the copy is already several lines tall
              and a floor would just push the buttons off a short screen. */}
          <p
            className="muted whatsnew-body"
            style={{ fontSize: 13.5, lineHeight: 1.6, margin: 0, whiteSpace: 'pre-line' }}
          >
            {t(`${prefix}_${current.key}_body`)}
          </p>
        </div>

        <div className="between whatsnew-footer" style={{ marginTop: 18, gap: 12, flexWrap: 'wrap' }}>
          <div className="row" style={{ gap: 6 }}>
            {pages.map((p, i) => (
              <button
                key={p.key}
                onClick={() => goTo(i)}
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
              <button className="btn" onClick={() => goTo(page - 1)}>
                <Icon name={rtl ? 'chevron-right' : 'chevron-left'} size={14} />
                {t('whatsnew_back')}
              </button>
            )}
            <button className="btn primary" onClick={() => (last ? finish() : goTo(page + 1))}>
              {last ? t('whatsnew_done') : t('whatsnew_next')}
              {!last && <Icon name={rtl ? 'chevron-left' : 'chevron-right'} size={14} />}
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
