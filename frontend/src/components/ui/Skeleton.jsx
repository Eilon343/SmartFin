export default function Sk({ width = '100%', height = 16, radius = 8, style = {} }) {
  return (
    <div style={{
      width, height,
      background: 'var(--hover-bg)',
      borderRadius: radius,
      animation: 'pulse 1.5s ease infinite',
      flexShrink: 0,
      ...style,
    }} />
  );
}
