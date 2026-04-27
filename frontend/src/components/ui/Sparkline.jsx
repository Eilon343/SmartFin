export default function Sparkline({ data, color = '#10b981', height = 56 }) {
  if (!data || data.length < 2) return null;
  const w = 320, h = height;
  const min = Math.min(...data), max = Math.max(...data);
  const span = Math.max(1, max - min);
  const step = w / (data.length - 1);
  const points = data.map((v, i) => [i * step, h - ((v - min) / span) * (h - 8) - 4]);
  const d = points.map((p, i) => (i === 0 ? `M${p[0]},${p[1]}` : `L${p[0]},${p[1]}`)).join(' ');
  const fill = `${d} L${w},${h} L0,${h} Z`;
  const id = `g-${color.replace('#', '')}`;
  return (
    <svg className="spark" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.32" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={fill} fill={`url(#${id})`} />
      <path d={d} fill="none" stroke={color} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      {points.map((p, i) =>
        i === points.length - 1 && <circle key={i} cx={p[0]} cy={p[1]} r="3" fill={color} />
      )}
    </svg>
  );
}
