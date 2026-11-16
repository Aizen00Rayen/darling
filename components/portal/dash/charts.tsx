import { formatMoney } from '@/lib/pricing';

/** Smooth area sparkline from a list of numbers (pure SVG, no dependency). */
export function Sparkline({ values, tone = 'light', label }: { values: number[]; tone?: 'light' | 'dark'; label: string }) {
  const w = 320;
  const h = 84;
  const pts = values.length > 1 ? values : [0, ...values, 0];
  const max = Math.max(1, ...pts);
  const min = Math.min(0, ...pts);
  const span = max - min || 1;
  const step = w / (pts.length - 1);
  const xy = pts.map((v, i) => [i * step, h - 8 - ((v - min) / span) * (h - 20)] as const);
  const line = xy.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const area = `${line} L${w},${h} L0,${h} Z`;
  const id = `sp-${tone}-${values.length}`;
  return (
    <svg className={`dd-spark dd-spark--${tone}`} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" role="img" aria-label={label}>
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="currentColor" stopOpacity=".45" />
          <stop offset="1" stopColor="currentColor" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${id})`} />
      <path d={line} fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

export interface BarDatum {
  label: string;
  sales: number;
  profit?: number | null;
}

/** Daily bars: sales (pink) with the profit inside (ink). Each bar has a tooltip title and the chart a text alternative. */
export function BarChart({ data, showProfit }: { data: BarDatum[]; showProfit: boolean }) {
  const max = Math.max(1, ...data.map((d) => d.sales));
  return (
    <div className="dd-bars" role="img" aria-label={`Ventes par jour, maximum ${formatMoney(max)}`}>
      {data.map((d) => {
        const h = Math.max(2, Math.round((d.sales / max) * 100));
        const p = showProfit && d.profit && d.profit > 0 ? Math.min(100, Math.round((d.profit / d.sales) * 100)) : 0;
        return (
          <div key={d.label} className="dd-bar" title={`${d.label} · ${formatMoney(d.sales)}${showProfit && d.profit != null ? ` · profit ${formatMoney(d.profit)}` : ''}`}>
            <div className="dd-bar__col" style={{ height: `${h}%` }}>
              {p > 0 ? <div className="dd-bar__profit" style={{ height: `${p}%` }} /> : null}
            </div>
            <span className="dd-bar__x">{d.label.slice(8)}</span>
          </div>
        );
      })}
    </div>
  );
}

export interface DonutDatum {
  label: string;
  value: number;
}
const PALETTE = ['#ed007d', '#24141c', '#9b6bff', '#ff9ac9', '#5c8a6e', '#d6a8bf'];

/** Share of sales per channel as a conic-gradient donut with an accessible legend. */
export function Donut({ data, centre }: { data: DonutDatum[]; centre: string }) {
  const total = data.reduce((n, d) => n + d.value, 0);
  let acc = 0;
  const stops = data.map((d, i) => {
    const from = (acc / (total || 1)) * 100;
    acc += d.value;
    return `${PALETTE[i % PALETTE.length]} ${from}% ${(acc / (total || 1)) * 100}%`;
  });
  return (
    <div className="dd-donut">
      <div className="dd-donut__ring" style={{ background: total > 0 ? `conic-gradient(${stops.join(',')})` : 'var(--line)' }} aria-hidden="true">
        <div className="dd-donut__hole">
          <strong>{centre}</strong>
        </div>
      </div>
      <ul className="dd-legend">
        {data.map((d, i) => (
          <li key={d.label}>
            <i style={{ background: PALETTE[i % PALETTE.length] }} aria-hidden="true" />
            <span>{d.label}</span>
            <b>{total > 0 ? Math.round((d.value / total) * 100) : 0}%</b>
          </li>
        ))}
        {data.length === 0 ? <li className="dd-empty">Pas encore de ventes ce mois-ci.</li> : null}
      </ul>
    </div>
  );
}

/** One segmented bar for the order pipeline. */
export function Funnel({ steps }: { steps: { label: string; value: number; tone: string; href: string }[] }) {
  const total = steps.reduce((n, s) => n + s.value, 0);
  return (
    <div>
      <div className="dd-funnel" role="img" aria-label="Répartition des commandes par statut">
        {steps.map((s) => (
          <a key={s.label} href={s.href} className={`dd-funnel__seg dd-tone-${s.tone}`} style={{ flexGrow: Math.max(s.value, total > 0 ? 0.0001 : 1) }} title={`${s.label} : ${s.value}`} />
        ))}
      </div>
      <ul className="dd-funnel__legend">
        {steps.map((s) => (
          <li key={s.label}>
            <a href={s.href}>
              <i className={`dd-tone-${s.tone}`} aria-hidden="true" />
              {s.label} <b>{s.value}</b>
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}
