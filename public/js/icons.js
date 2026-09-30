/* Icon registry — one internally consistent 16×16 stroke set (UI-2).
   Stroke-only, currentColor, 1.6 width, round caps. No emoji, no mixed
   Unicode glyphs. Usage: icon('inbox') → svg string; css sizes it. */

const P = {
  overview: '<rect x="2.5" y="2.5" width="4.6" height="4.6" rx="1"/><rect x="8.9" y="2.5" width="4.6" height="4.6" rx="1"/><rect x="2.5" y="8.9" width="4.6" height="4.6" rx="1"/><rect x="8.9" y="8.9" width="4.6" height="4.6" rx="1"/>',
  devices: '<rect x="2.2" y="3" width="11.6" height="7.6" rx="1.4"/><path d="M6.4 13.4h3.2M8 10.6v2.8"/>',
  infrastructure: '<rect x="2.5" y="2.5" width="11" height="4.4" rx="1.2"/><rect x="2.5" y="9.1" width="11" height="4.4" rx="1.2"/><circle cx="5" cy="4.7" r=".8"/><circle cx="5" cy="11.3" r=".8"/>',
  review: '<path d="M5.6 2.7H4a1.2 1.2 0 0 0-1.2 1.2v8.9a1.2 1.2 0 0 0 1.2 1.2h8a1.2 1.2 0 0 0 1.2-1.2V3.9a1.2 1.2 0 0 0-1.2-1.2h-1.6"/><rect x="5.7" y="1.5" width="4.6" height="2.4" rx="1"/><path d="m5.3 9.8 1.8 1.8 3.5-4"/>',
  inbox: '<path d="M3.7 3.4 1.5 8v4.2a1.3 1.3 0 0 0 1.3 1.3h10.4a1.3 1.3 0 0 0 1.3-1.3V8l-2.2-4.6a1.3 1.3 0 0 0-1.2-.7H4.9a1.3 1.3 0 0 0-1.2.7z"/><path d="M1.5 8h3.9l1.3 2h2.6l1.3-2h3.9"/>',
  reports: '<path d="M4 2.5h5.4L12.8 6v7.5H4z"/><path d="M9.2 2.5V6h3.6"/><path d="M6 9h4.6M6 11.4h4.6"/>',
  approvals: '<path d="M8 2.2 3 4.6v3.3c0 3 2.1 5.1 5 6 2.9-.9 5-3 5-6V4.6z"/><path d="m5.8 7.6 1.6 1.6 3-3.2"/>',
  activity: '<path d="M2 8h3l1.8-4.4 2.6 8.4L11.4 8H14"/>',
  settings: '<circle cx="8" cy="8" r="2.2"/><path d="M8 1.8v1.9M8 12.3v1.9M2.6 4.6l1.6 1M11.8 10.4l1.6 1M2.6 11.4l1.6-1M11.8 5.6l1.6-1"/>',
  search: '<circle cx="7" cy="7" r="4.4"/><path d="m10.4 10.4 3 3"/>',
  'chev-r': '<path d="m6 3.2 4.8 4.8L6 12.8"/>',
  'chev-d': '<path d="m3.2 6 4.8 4.8L12.8 6"/>',
  'chev-u': '<path d="m3.2 10 4.8-4.8L12.8 10"/>',
  warn: '<path d="M8 2.4 14.6 13.4H1.4z"/><path d="M8 6.4v3"/><circle cx="8" cy="11.6" r=".7" fill="currentColor" stroke="none"/>',
  bulb: '<path d="M8 1.8a3.7 3.7 0 0 0-2 6.9c.5.3.7.7.7 1.2v.3h2.6v-.3c0-.5.2-.9.7-1.2A3.7 3.7 0 0 0 8 1.8z"/><path d="M6.8 12.2h2.4M7.2 14h1.6"/>',
  help: '<circle cx="8" cy="8" r="6"/><path d="M6.2 6.1A1.9 1.9 0 0 1 8 4.4c1 0 1.9.7 1.9 1.7 0 1.2-1 1.6-1.9 2.1v.7"/><circle cx="8" cy="11.4" r=".7" fill="currentColor" stroke="none"/>',
  decide: '<rect x="2.6" y="2.6" width="10.8" height="10.8" rx="1.6"/><path d="m5.2 8.2 1.9 1.9 3.7-4"/>',
  note: '<path d="M2.8 3.2h10.4v7.6H8.4l-3.2 2.4v-2.4H2.8z"/><path d="M5.4 6h5.2M5.4 8.4h3.4"/>',
  eye: '<path d="M1.6 8S4 4 8 4s6.4 4 6.4 4-2.4 4-6.4 4S1.6 8 1.6 8z"/><circle cx="8" cy="8" r="1.9"/>',
  filter: '<path d="M2.4 3.4h11.2l-4.4 4.6v4.2l-2.4 1.4V8z"/>',
  kebab: '<circle cx="8" cy="3.4" r="1"/><circle cx="8" cy="8" r="1"/><circle cx="8" cy="12.6" r="1"/>',
  clock: '<circle cx="8" cy="8" r="6"/><path d="M8 4.6V8l2.4 1.6"/>',
  check: '<path d="m3 8.4 3.4 3.4L13 4.6"/>',
  building: '<rect x="3" y="2.6" width="10" height="11" rx="1"/><path d="M6 5.4h1.4M8.6 5.4H10M6 8h1.4M8.6 8H10M6 10.6h1.4M8.6 10.6H10"/>',
  hud: '<circle cx="8" cy="8" r="5.8"/><circle cx="8" cy="8" r="2.6"/><path d="M8 2.2v1.6M8 12.2v1.6M2.2 8h1.6M12.2 8h1.6"/>',
  analytics: '<path d="M2.5 13.5h11"/><path d="M4.2 11V8.2M7 11V4.6M9.8 11V6.8M12.6 11V3"/>',
  terminal: '<rect x="1.8" y="2.8" width="12.4" height="10.4" rx="1.6"/><path d="m4.6 6.4 2 1.7-2 1.7M8.4 10.2h3"/>',
  book: '<path d="M2.8 3.2c1.8-.6 3.6-.4 5.2.9v9.1c-1.6-1.3-3.4-1.5-5.2-.9z"/><path d="M13.2 3.2c-1.8-.6-3.6-.4-5.2.9v9.1c1.6-1.3 3.4-1.5 5.2-.9z"/>',
  bell: '<path d="M4 11V7.4a4 4 0 0 1 8 0V11l1.2 1.3H2.8z"/><path d="M6.6 14h2.8"/>',
  'sidebar-l': '<rect x="2" y="2.6" width="12" height="10.8" rx="1.6"/><path d="M6 2.6v10.8M10.6 6.2 9 8l1.6 1.8"/>',
  'sidebar-r': '<rect x="2" y="2.6" width="12" height="10.8" rx="1.6"/><path d="M6 2.6v10.8M9 6.2 10.6 8 9 9.8"/>',
  server: '<rect x="2.6" y="2.2" width="10.8" height="4.6" rx="1.2"/><rect x="2.6" y="9.2" width="10.8" height="4.6" rx="1.2"/><path d="M5 4.5h.01M5 11.5h.01M8 4.5h3M8 11.5h3"/>',
  shield: '<path d="M8 1.9 3 4v3.6c0 3 2.1 5.2 5 6.3 2.9-1.1 5-3.3 5-6.3V4z"/>',
  key: '<circle cx="5.4" cy="10.6" r="2.8"/><path d="m7.4 8.6 5.4-5.4M11 4.9l1.5 1.5M9.6 6.3l1.2 1.2"/>',
  fingerprint: '<path d="M4.3 12.4c.5-1.3.7-2.7.7-4.2a3 3 0 0 1 6 0c0 .9 0 1.8-.2 2.7"/><path d="M8 8.2c0 2.2-.4 4.2-1.3 5.8M10.3 13.2c.2-.5.4-1 .5-1.6M2.6 10.6c.3-.8.4-1.6.4-2.4a5 5 0 0 1 8.6-3.5M13 7c.1.4.1.8.1 1.2"/>',
  bolt: '<path d="M9 1.8 3.6 9.2h4l-.8 5 5.6-7.6H8.4z"/>',
  network: '<rect x="6" y="1.8" width="4" height="3.2" rx=".8"/><rect x="1.6" y="11" width="4" height="3.2" rx=".8"/><rect x="10.4" y="11" width="4" height="3.2" rx=".8"/><path d="M8 5v3M3.6 11V9.2c0-.7.5-1.2 1.2-1.2h6.4c.7 0 1.2.5 1.2 1.2V11"/>',
  printer: '<path d="M4.4 6V2.4h7.2V6"/><rect x="2" y="6" width="12" height="5.4" rx="1.2"/><path d="M4.4 9.6h7.2v4H4.4z"/>',
  firewall: '<rect x="2" y="2.6" width="12" height="10.8" rx="1.2"/><path d="M2 6.2h12M2 9.8h12M6 2.6v3.6M10 6.2v3.6M6 9.8v3.6"/>',
  pulse: '<path d="M1.6 8h2.6l1.4-3.4L8 12l2-5 1 1h3.4"/>',
  sparkle: '<path d="M8 1.8 9.3 6.7 14.2 8 9.3 9.3 8 14.2 6.7 9.3 1.8 8l4.9-1.3z"/>',
  refresh: '<path d="M13.2 7.4A5.2 5.2 0 0 0 3.6 5M2.8 8.6A5.2 5.2 0 0 0 12.4 11"/><path d="M3.3 2.4v2.8h2.8M12.7 13.6v-2.8H9.9"/>',
  'arrow-ur': '<path d="M5 11 11 5M6 5h5v5"/>',
  x: '<path d="m4 4 8 8M12 4l-8 8"/>',
  cpu: '<rect x="4" y="4" width="8" height="8" rx="1.2"/><rect x="6.2" y="6.2" width="3.6" height="3.6" rx=".5"/><path d="M6 1.8V4M10 1.8V4M6 12v2.2M10 12v2.2M1.8 6H4M1.8 10H4M12 6h2.2M12 10h2.2"/>',
  wifi: '<path d="M1.8 6.2a9 9 0 0 1 12.4 0M4 8.6a5.8 5.8 0 0 1 8 0M6.2 11a2.6 2.6 0 0 1 3.6 0"/><circle cx="8" cy="13.2" r=".6" fill="currentColor" stroke="none"/>',
  lock: '<rect x="3" y="7" width="10" height="7" rx="1.4"/><path d="M5.2 7V5.2a2.8 2.8 0 0 1 5.6 0V7"/>',
  user: '<circle cx="8" cy="5.6" r="2.8"/><path d="M2.8 13.8c.6-2.6 2.7-4.2 5.2-4.2s4.6 1.6 5.2 4.2"/>',
  layers: '<path d="M8 2 14 5.2 8 8.4 2 5.2z"/><path d="m2 8 6 3.2L14 8M2 10.8 8 14l6-3.2"/>',
  history: '<path d="M2.6 8a5.4 5.4 0 1 0 1.6-3.8"/><path d="M2.4 2.4v2.8h2.8M8 5.2V8l2 1.4"/>',
};

export const icon = (name, cls = '') =>
  `<svg class="ic ${cls}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[name] ?? P.help}</svg>`;

/** Icon inside a tinted rounded tile — used by page headers and stat cards. */
export const iconTile = (name, tone = 'accent') =>
  `<span class="icon-tile tile-${tone}">${icon(name)}</span>`;
