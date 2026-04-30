import { useEffect } from 'react';
import Icon from './Icon';

export default function Toast({ msg, onDone }) {
  useEffect(() => {
    if (!msg) return;
    const t = setTimeout(onDone, 2400);
    return () => clearTimeout(t);
  }, [msg, onDone]);
  if (!msg) return null;
  return (
    <div style={{
      position: 'fixed', bottom: 96, left: '50%', transform: 'translateX(-50%)',
      background: 'var(--card)', border: '1px solid var(--line-2)',
      padding: '10px 16px', borderRadius: 12, color: 'var(--text-1)',
      boxShadow: 'var(--pop-shadow)', zIndex: 80,
      animation: 'pop .25s ease', fontSize: 13, fontWeight: 500,
      whiteSpace: 'nowrap', maxWidth: 'calc(100vw - 32px)',
    }}>
      <span className="row" style={{ gap: 8 }}>
        <Icon name="check-circle-2" size={16} color="var(--emerald)" />
        {msg}
      </span>
    </div>
  );
}
