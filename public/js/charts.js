/* Charts — dependency-free SVG renderers returning markup strings.
   All colors come from semantic chart/status tokens via currentColor or
   var(--…) so every chart follows theme + accent. Every chart carries a
   <title> text alternative; numbers shown in charts are also shown as text
   nearby (a chart is never the only carrier of a value). */
import { esc } from './core.js';

let uid = 0;
const nid = (p) => `${p}${++uid}`;
const clamp01 = (v) => Math.max(0, Math.min(1, v));

/** Radial gauge ring. value/total → arc; segments optional [{value, color}]. */
export function ring({ value, total, size = 200, stroke = 14, label = '', segments = null, title = '' }) {
  const r = (size - stroke) / 2 - 6;
  const c = 2 * Math.PI * r;
  const pct = total > 0 ? clamp01(value / total) : 0;
  const glow = nid('rg');
  const grad = nid('rgr');
  const ticks = Array.from({ length: 60 }, (_, i) => {
    const a = (i / 60) * Math.PI * 2 - Math.PI / 2;
    const r1 = size / 2 - 2; const r2 = r1 - (i % 5 === 0 ? 5 : 2.5);
    return `<line x1="${size / 2 + Math.cos(a) * r1}" y1="${size / 2 + Math.sin(a) * r1}" x2="${size / 2 + Math.cos(a) * r2}" y2="${size / 2 + Math.sin(a) * r2}" />`;
  }).join('');
  let arcs = '';
  if (segments?.length) {
    let off = 0;
    for (const s of segments) {
      const len = total > 0 ? (s.value / total) * c : 0;
      if (len > 0) arcs += `<circle class="ring-arc" cx="${size / 2}" cy="${size / 2}" r="${r}" stroke="${s.color}" stroke-width="${stroke}" stroke-dasharray="${Math.max(len - 3, 0.1)} ${c}" stroke-dashoffset="${-off}" style="--len:${len}" filter="url(#${glow})" />`;
      off += len;
    }
  } else {
    arcs = `<circle class="ring-arc" cx="${size / 2}" cy="${size / 2}" r="${r}" stroke="url(#${grad})" stroke-width="${stroke}" stroke-dasharray="${pct * c} ${c}" style="--len:${pct * c}" filter="url(#${glow})" />`;
  }
  return `<svg class="ring" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" role="img" aria-label="${esc(title || label)}">
    <title>${esc(title || label)}</title>
    <defs>
      <filter id="${glow}" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="3.5" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
      <linearGradient id="${grad}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="var(--accent-strong)"/><stop offset="1" stop-color="var(--chart-2)"/></linearGradient>
    </defs>
    <g class="ring-ticks">${ticks}</g>
    <circle class="ring-track" cx="${size / 2}" cy="${size / 2}" r="${r}" stroke-width="${stroke}" />
    <g transform="rotate(-90 ${size / 2} ${size / 2})">${arcs}</g>
  </svg>`;
}

/** Tiny bar sparkline (values ≥ 0). */
export function sparkBars(values, { w = 120, h = 32, gap = 2, color = 'var(--chart-1)', title = '' } = {}) {
  const max = Math.max(1, ...values);
  const bw = (w - gap * (values.length - 1)) / Math.max(values.length, 1);
  const bars = values.map((v, i) => {
    const bh = v > 0 ? Math.max(2, (v / max) * (h - 2)) : 1;
    return `<rect x="${(i * (bw + gap)).toFixed(2)}" y="${(h - bh).toFixed(2)}" width="${bw.toFixed(2)}" height="${bh.toFixed(2)}" rx="1.5" fill="${v > 0 ? color : 'var(--chart-grid)'}" opacity="${v > 0 ? 1 : 0.6}" />`;
  }).join('');
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="${esc(title)}"><title>${esc(title)}</title>${bars}</svg>`;
}

/** Stacked daily bars with axis labels. series: [{date, ...keys}] keys: [{key,label,color}] */
export function stackedBars(series, keys, { w = 520, h = 180, title = '' } = {}) {
  const padL = 26; const padB = 22; const padT = 8;
  const iw = w - padL - 4; const ih = h - padB - padT;
  const totals = series.map((d) => keys.reduce((s, k) => s + (d[k.key] || 0), 0));
  const max = Math.max(4, ...totals);
  const step = niceStep(max);
  const top = Math.ceil(max / step) * step;
  const bw = iw / series.length;
  const grid = [];
  for (let v = 0; v <= top; v += step) {
    const y = padT + ih - (v / top) * ih;
    grid.push(`<line x1="${padL}" x2="${w - 4}" y1="${y}" y2="${y}" class="grid-line"/><text x="${padL - 6}" y="${y + 3.5}" class="axis" text-anchor="end">${v}</text>`);
  }
  const bars = series.map((d, i) => {
    let y = padT + ih;
    const x = padL + i * bw + bw * 0.18;
    const segs = keys.map((k) => {
      const v = d[k.key] || 0;
      if (!v) return '';
      const hh = (v / top) * ih;
      y -= hh;
      return `<rect class="bar" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${(bw * 0.64).toFixed(1)}" height="${Math.max(hh - 1, 1).toFixed(1)}" rx="3" fill="${k.color}" style="--i:${i}"><title>${esc(d.date)} · ${esc(k.label)}: ${v}</title></rect>`;
    }).join('');
    const every = Math.ceil(series.length / 7);
    const isLast = i === series.length - 1;
    // Regular ticks, plus the last day — dropping a regular tick that would collide with it.
    const lbl = isLast || (i % every === 0 && series.length - 1 - i >= every * 0.6)
      ? `<text x="${(padL + i * bw + bw / 2).toFixed(1)}" y="${h - 6}" class="axis" text-anchor="middle">${esc(shortDate(d.date))}</text>` : '';
    return segs + lbl;
  }).join('');
  return `<svg class="chart" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-label="${esc(title)}"><title>${esc(title)}</title>${grid.join('')}${bars}</svg>`;
}

/** Horizontal bars list — returns HTML (labels stay real text). */
export function hBars(rows, { color = 'var(--chart-1)', onKey = null } = {}) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return `<div class="hbars">${rows.map((r, i) => `
    <div class="hbar${onKey ? ' clickable' : ''}" ${onKey ? `data-key="${esc(r.key ?? r.label)}" tabindex="0" role="button"` : ''} style="--i:${i}">
      <span class="hbar-label">${esc(r.label)}</span>
      <span class="hbar-track"><span class="hbar-fill" style="width:${(r.value / max) * 100}%;background:${r.color ?? color}"></span></span>
      <span class="hbar-val">${r.value}</span>
    </div>`).join('')}</div>`;
}

/** Smooth area line for a numeric series. */
export function areaLine(values, { w = 300, h = 60, color = 'var(--chart-1)', title = '' } = {}) {
  if (!values.length) return '';
  const max = Math.max(1, ...values);
  const pts = values.map((v, i) => [values.length === 1 ? w / 2 : (i / (values.length - 1)) * w, h - 3 - (v / max) * (h - 8)]);
  const d = pts.map((p, i) => {
    if (i === 0) return `M${p[0].toFixed(1)},${p[1].toFixed(1)}`;
    const prev = pts[i - 1]; const cx = (prev[0] + p[0]) / 2;
    return `C${cx.toFixed(1)},${prev[1].toFixed(1)} ${cx.toFixed(1)},${p[1].toFixed(1)} ${p[0].toFixed(1)},${p[1].toFixed(1)}`;
  }).join(' ');
  const g = nid('al');
  return `<svg class="area" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-label="${esc(title)}"><title>${esc(title)}</title>
    <defs><linearGradient id="${g}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${color}" stop-opacity=".35"/><stop offset="1" stop-color="${color}" stop-opacity="0"/></linearGradient></defs>
    <path d="${d} L${w},${h} L0,${h} Z" fill="url(#${g})"/><path d="${d}" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" vector-effect="non-scaling-stroke"/></svg>`;
}

function niceStep(max) {
  const raw = max / 4;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const n = raw / pow;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * pow;
}
function shortDate(iso) {
  const d = new Date(`${iso}T12:00:00`);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** Animate numeric text from 0 → target (respects reduced motion). */
export function countUp(root) {
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  root.querySelectorAll('[data-count]').forEach((el) => {
    const target = Number(el.dataset.count);
    const dec = Number(el.dataset.dec || 0);
    const suffix = el.dataset.suffix || '';
    if (!Number.isFinite(target) || reduce) { el.textContent = `${target.toFixed(dec)}${suffix}`; return; }
    const t0 = performance.now(); const dur = 900;
    const tick = (t) => {
      const p = Math.min(1, (t - t0) / dur);
      const e = 1 - (1 - p) ** 4;
      el.textContent = `${(target * e).toFixed(dec)}${suffix}`;
      if (p < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}
