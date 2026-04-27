export function pct(a, b) { return b <= 0 ? 0 : (a / b) * 100; }
export function tone(p) { return p < 50 ? 'ok' : p < 80 ? 'warn' : 'over'; }

export default function ProgressBar({ value, max, height = 6 }) {
  const p = Math.min(100, Math.max(0, pct(value, max)));
  const t = tone(p);
  return (
    <div className="pb-track" style={{ height }}>
      <div className={`pb-fill ${t}`} style={{ width: Math.min(100, p) + '%' }} />
    </div>
  );
}
