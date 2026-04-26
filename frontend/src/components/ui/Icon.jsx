import * as LucideIcons from 'lucide-react';

export default function Icon({ name, size = 16, strokeWidth = 1.75, color, style, className }) {
  if (!name) return null;
  const pascal = name.split(/[-_]/).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join('');
  const IconComponent = LucideIcons[pascal];
  if (!IconComponent) return null;
  return <IconComponent size={size} strokeWidth={strokeWidth} color={color} style={style} className={className} />;
}
