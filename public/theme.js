/* Appearance controller — theme/accent/density/sidebar.
   Stored under the `n1_appearance` namespace; applied via data-* attributes
   on <html> so theme.css resolves it. The inline <head> script in index.html
   mirrors applyAppearance() before first paint to avoid a theme flash.
   v3: cyan is the default accent. Pre-v3 prefs stored accent:'blue' as the
   implicit default, so unversioned prefs migrate blue → cyan once. */

const APPEARANCE_KEY = 'n1_appearance';
const DEFAULTS = { v: 3, theme: 'dark', accent: 'cyan', density: 'compact', sidebar: 'expanded' };
export const ACCENTS = ['cyan', 'blue', 'violet', 'teal'];

export function getAppearance() {
  try {
    const raw = JSON.parse(localStorage.getItem(APPEARANCE_KEY) || '{}');
    if (!raw.v && raw.accent === 'blue') raw.accent = 'cyan';
    const a = { ...DEFAULTS, ...raw, v: 3 };
    if (!ACCENTS.includes(a.accent)) a.accent = 'cyan';
    return a;
  } catch {
    return { ...DEFAULTS };
  }
}

export function applyAppearance(a) {
  const root = document.documentElement;
  if (a.theme === 'system') delete root.dataset.theme;
  else root.dataset.theme = a.theme;
  if (a.accent === 'cyan') delete root.dataset.accent;
  else root.dataset.accent = a.accent;
  if (a.density === 'compact') delete root.dataset.density;
  else root.dataset.density = a.density;
  if (a.sidebar === 'collapsed') root.dataset.sidebar = 'collapsed';
  else delete root.dataset.sidebar;
}

/** Blocking early init — call from an inline <head> script before CSS paint. */
export function initTheme() {
  applyAppearance(getAppearance());
  // 'system' follows OS changes live.
  matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
    if (getAppearance().theme === 'system') applyAppearance(getAppearance());
  });
}

export function setAppearance(patch) {
  const next = { ...getAppearance(), ...patch };
  localStorage.setItem(APPEARANCE_KEY, JSON.stringify(next));
  // Theme swaps morph instead of snapping where View Transitions exist.
  if (document.startViewTransition && ('theme' in patch || 'accent' in patch)) {
    document.startViewTransition(() => applyAppearance(next));
  } else {
    applyAppearance(next);
  }
  return next;
}

const cap = (t) => t[0].toUpperCase() + t.slice(1);

/** Appearance menu markup + wiring for the shell. */
export function appearanceMenu() {
  const a = getAppearance();
  return `
    <div class="appearance-menu" role="group" aria-label="Appearance">
      <div class="appearance-row"><span class="appearance-label">Theme</span>
        <div class="seg" role="radiogroup" aria-label="Theme">
          ${['dark', 'light', 'system'].map((t) => `<button class="seg-btn" data-app-theme="${t}" role="radio" aria-checked="${a.theme === t}">${cap(t)}</button>`).join('')}
        </div></div>
      <div class="appearance-row"><span class="appearance-label">Accent</span>
        <div class="seg" role="radiogroup" aria-label="Accent">
          ${ACCENTS.map((t) => `<button class="seg-btn accent-${t}" data-app-accent="${t}" role="radio" aria-checked="${a.accent === t}" title="${cap(t)}"><span class="accent-dot"></span></button>`).join('')}
        </div></div>
      <div class="appearance-row"><span class="appearance-label">Density</span>
        <div class="seg" role="radiogroup" aria-label="Density">
          ${['compact', 'comfortable'].map((t) => `<button class="seg-btn" data-app-density="${t}" role="radio" aria-checked="${a.density === t}">${cap(t)}</button>`).join('')}
        </div></div>
    </div>`;
}

export function wireAppearanceMenu(root) {
  root.querySelectorAll('[data-app-theme]').forEach((b) =>
    b.addEventListener('click', () => refreshSeg(setAppearance({ theme: b.dataset.appTheme }))));
  root.querySelectorAll('[data-app-accent]').forEach((b) =>
    b.addEventListener('click', () => refreshSeg(setAppearance({ accent: b.dataset.appAccent }))));
  root.querySelectorAll('[data-app-density]').forEach((b) =>
    b.addEventListener('click', () => refreshSeg(setAppearance({ density: b.dataset.appDensity }))));

  function refreshSeg(a) {
    root.querySelectorAll('[data-app-theme]').forEach((x) => x.setAttribute('aria-checked', String(x.dataset.appTheme === a.theme)));
    root.querySelectorAll('[data-app-accent]').forEach((x) => x.setAttribute('aria-checked', String(x.dataset.appAccent === a.accent)));
    root.querySelectorAll('[data-app-density]').forEach((x) => x.setAttribute('aria-checked', String(x.dataset.appDensity === a.density)));
  }
}
