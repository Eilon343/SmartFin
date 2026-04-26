export default function PageHeader({ title, sub, actions }) {
  return (
    <div className="between" style={{ marginBottom: 22, gap: 14, flexWrap: 'wrap' }}>
      <div className="stack" style={{ gap: 4 }}>
        <h1 className="h1">{title}</h1>
        {sub && <div className="muted" style={{ fontSize: 13 }}>{sub}</div>}
      </div>
      {actions && <div className="row" style={{ gap: 8 }}>{actions}</div>}
    </div>
  );
}
