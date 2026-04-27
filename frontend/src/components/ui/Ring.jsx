export default function Ring({ value, max, color = '#6366f1', size = 84, stroke = 8, label }) {
  const p = Math.min(1, value / Math.max(1, max));
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  return (
    <div className="ring-wrap" style={{ width: size, height: size }}>
      <svg width={size} height={size} style={{ transform: 'rotate(-90deg)' }}>
        <circle cx={size / 2} cy={size / 2} r={r} stroke="var(--track)" strokeWidth={stroke} fill="none" />
        <circle
          cx={size / 2} cy={size / 2} r={r}
          stroke={color} strokeWidth={stroke} fill="none"
          strokeLinecap="round"
          strokeDasharray={`${c * p} ${c}`}
          style={{ transition: 'stroke-dasharray .8s cubic-bezier(.2,.8,.2,1)' }}
        />
      </svg>
      <div className="ring-label">{label ?? `${Math.round(p * 100)}%`}</div>
    </div>
  );
}
