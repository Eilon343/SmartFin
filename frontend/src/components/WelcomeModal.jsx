import { useI18n } from '../context/I18nContext';
import TourDeck from './ui/TourDeck';

/**
 * First-run introduction, shown once per account rather than once per browser — the server
 * owns that flag (users.onboarded_at), so it does not reappear on a second device.
 *
 * Four pages, ordered by what someone can do soonest: log something by hand today, hand
 * the typing to the bot, let the bank do it for them, then the reporting that only becomes
 * interesting once data exists. Deliberately short — a first-run tour competes with the
 * user's actual reason for opening the app, and every extra page is a page more likely to
 * be skipped wholesale.
 */
const PAGES = [
  { icon: 'sparkles',    key: 'intro',  accent: 'var(--emerald)' },
  { icon: 'message-circle', key: 'log', accent: 'var(--indigo)' },
  { icon: 'landmark',    key: 'sync',   accent: 'var(--indigo)' },
  { icon: 'trending-up', key: 'plan',   accent: 'var(--amber)' },
];

export default function WelcomeModal({ open, onFinish }) {
  const { t } = useI18n();

  return (
    <TourDeck
      open={open}
      pages={PAGES}
      prefix="welcome"
      eyebrow={t('welcome_eyebrow')}
      onFinish={onFinish}
    />
  );
}
