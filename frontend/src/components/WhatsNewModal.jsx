import { useI18n } from '../context/I18nContext';
import { markWhatsNewSeen } from '../lib/whatsNew';
import TourDeck from './ui/TourDeck';

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
  const { t } = useI18n();

  return (
    <TourDeck
      open={open}
      pages={PAGES}
      prefix="whatsnew"
      eyebrow={t('whatsnew_eyebrow')}
      onFinish={() => {
        markWhatsNewSeen();
        onClose();
      }}
    />
  );
}
