// 异形屏适配 (the owner, 2026-10-14: on some phones Chrome's fullscreen puts the interface under the camera cutout or the
// curved edge, or leaves it off-centre): 设置 → 异形屏适配 moves each edge of the interface by a number of CSS pixels the
// player picks while watching it move. Each slider reads 0–100 and starts at 50 = unchanged (the owner, same day):
// right of 50 pulls that edge in, left of 50 pushes it out past the reported viewport — 2 CSS px per step, ±100 px.
// Kept per device (`sp.pref.screenFit`, not one of ui/accountPrefs.js's synced keys: another phone has another cutout);
// the stored values are the pixel offsets (inward positive), so a profile saved by the first version (0–160 px inward)
// keeps its meaning, clamped to 100.
// Applied on <html>: `data-fit` plus --fit-l / --fit-r / --fit-t / --fit-b; css/devices.css then sets .app-root (the
// screens' fixed box, theme.css) and the full-page panels to that box (every .screen is absolute inset 0 inside it, the
// board is sized from its host element) and computes the layout root 1rem from it instead of the whole viewport. Fixed
// overlays (dialogs, toasts) keep the full screen.
// Feedback #16 (10-16: 「调回 80% 之后手机横屏三分之一是黑屏」): the 底部 track sat 8 px above 界面大小's buttons, a tap on a
// range track jumps the value there, and the result outlived reloads while 界面大小 still read 80%. So the section is
// folded by default (its head says 已调整 and offers 重置 whenever an edge is moved), the readings are the pixel offsets
// (±N px, not a 0–100 that reads like a percentage), and on touch a tap on the track away from the thumb does nothing —
// the thumb is dragged, or −/+ steps.

import { useState } from '../../vendor/hooks.module.js';
import { html, Button, MicroLabel } from './components.js';
import { createStore, useStore, loadPref, savePref } from '../store.js';
import { t, N_ } from '../../../shared/i18n.js';

export const FIT_SIDES = ['l', 'r', 't', 'b'];
/** Pixel offset range (inward positive) and the slider scale: value = MID + px / PX_PER_STEP. */
export const FIT_MIN = -100, FIT_MAX = 100, MID = 50, PX_PER_STEP = 2;
const NONE = { l: 0, r: 0, t: 0, b: 0 };

/** A stored value → four whole pixel offsets in FIT_MIN..FIT_MAX (anything else → 0). */
export function sanitizeFit(v) {
  const out = { ...NONE };
  if (v && typeof v === 'object') for (const k of FIT_SIDES) {
    const n = Math.round(Number(v[k]));
    out[k] = Number.isFinite(n) ? Math.min(FIT_MAX, Math.max(FIT_MIN, n)) : 0;
  }
  return out;
}
/** The slider's 0–100 reading of a pixel offset, and back. */
export const sliderOf = (px) => Math.round(MID + px / PX_PER_STEP);
export const pxOf = (v) => (Number(v) - MID) * PX_PER_STEP;

export const fitStore = createStore(sanitizeFit(loadPref('screenFit', null)));

/** Put the offsets on <html> (no attribute while all four are 0: the page is exactly as before). */
export function applyFit(f) {
  const el = globalThis.document?.documentElement;
  if (!el) return;
  const on = FIT_SIDES.some((k) => f[k] !== 0);
  if (on) {
    el.dataset.fit = '';
    for (const k of FIT_SIDES) el.style.setProperty(`--fit-${k}`, `${f[k]}px`);
  } else {
    delete el.dataset.fit;
    for (const k of FIT_SIDES) el.style.removeProperty(`--fit-${k}`);
  }
  // the board and the HUD measure their host on resize (render/app.js, ui/fieldHost.js)
  try { globalThis.dispatchEvent?.(new Event('resize')); } catch { /* old browsers */ }
}

fitStore.subscribe((f) => { savePref('screenFit', f); applyFit(f); });
applyFit(fitStore.get());

/** @param {Partial<{l:number,r:number,t:number,b:number}>} patch pixel offsets */
export const updateFit = (patch) => fitStore.set(sanitizeFit({ ...fitStore.get(), ...patch }));

const SIDE_NAMES = { l: N_('左侧'), r: N_('右侧'), t: N_('顶部'), b: N_('底部') };
const SIDE_MICRO = { l: 'LEFT', r: 'RIGHT', t: 'TOP', b: 'BOTTOM' };
const LO = sliderOf(FIT_MIN), HI = sliderOf(FIT_MAX);

/** The reading of a pixel offset: 0, or ±N px (inward positive, as stored). */
export const fitLabel = (px) => (px ? `${px > 0 ? '+' : '−'}${Math.abs(px)} px` : '0');

/**
 * Whether a touch at clientX on a range input starts on (or right by) its thumb: a touch elsewhere on the track is
 * ignored, so a tap meant for a neighbouring control cannot jump the value (the thumb is assumed ~1 track-height wide).
 * @param {{ left: number, width: number, height: number }} rect @param {number} value @param {number} lo @param {number} hi
 */
export function nearThumb(rect, clientX, value, lo, hi, slop = 24) {
  const thumb = Math.max(16, rect.height);
  const x = rect.left + thumb / 2 + (rect.width - thumb) * ((value - lo) / ((hi - lo) || 1));
  return Math.abs(clientX - x) <= thumb / 2 + slop;
}

// A touch that lands on the track away from the thumb: the browser still moves the thumb there (cancelling the
// touchstart does not stop a range input), so the inputs of that press are put back instead.
let strayTouch = null;
function guardDown(e) {
  const el = e.currentTarget;
  strayTouch = e.pointerType !== 'mouse' && el && !nearThumb(el.getBoundingClientRect(), e.clientX, Number(el.value), Number(el.min), Number(el.max)) ? el : null;
}
const guardUp = () => { strayTouch = null; };

/**
 * The settings section, folded by default: the head shows 已调整 (and 重置) while any edge is moved; open, one slider
 * per edge (centre = unchanged; reading ±N px), −/+ one step for a fine touch.
 */
export function ScreenFitSection() {
  const f = useStore((s) => s, Object.is, fitStore);
  const [open, setOpen] = useState(false);
  const any = FIT_SIDES.some((k) => f[k] !== 0);
  return html`<section class=${`set-fit${open ? ' is-open' : ''}`} aria-labelledby="set-fit-title">
    <div class="set-keys__head">
      <button type="button" class="set-fit__toggle" aria-expanded=${open ? 'true' : 'false'} aria-controls="set-fit-body" data-testid="fit-toggle" onClick=${() => setOpen(!open)}>
        <span class="set-row__label" id="set-fit-title">${t('异形屏适配')}<${MicroLabel}>SCREEN FIT<//></span>
        ${any ? html`<span class="set-fit__badge" data-testid="fit-badge">${t('已调整')}</span>` : null}
        <span class="set-fit__chev" aria-hidden="true"></span>
      </button>
      ${any ? html`<${Button} variant="ghost" size="sm" icon="refresh" class="set-fit__reset" data-testid="fit-reset" onClick=${() => updateFit(NONE)}>${t('重置')}<//>` : null}
    </div>
    ${open ? html`<div id="set-fit-body" class="set-fit__body">
      <p class="set-hint">${t('全屏后界面被挖孔、刘海或曲面边缘挡住，或比例、位置不对时使用：滑块居中（0）为不调整，往右拉该边往里收，往左拉该边往外扩，单位为像素。界面会立即移动，可边看边调，只保存在这台设备上；触屏请拖动滑块或用 −/+。')}</p>
      ${FIT_SIDES.map((k) => {
        const v = sliderOf(f[k]);
        return html`<div key=${k} class="set-row set-fit__row">
          <span class="set-row__label">${t(SIDE_NAMES[k])}<${MicroLabel}>${SIDE_MICRO[k]}<//></span>
          <button type="button" class="set-fit__step" aria-label=${t('减少')} disabled=${v <= LO} onClick=${() => updateFit({ [k]: pxOf(v - 1) })}>−</button>
          <input class="set-range" type="range" min=${LO} max=${HI} step="1" value=${v} style=${`--pct:${v}%`}
            aria-label=${t(SIDE_NAMES[k])} aria-valuetext=${fitLabel(f[k])} data-testid=${`fit-${k}`} onPointerDown=${guardDown} onPointerUp=${guardUp} onPointerCancel=${guardUp}
            onInput=${(e) => { if (strayTouch === e.currentTarget) { e.currentTarget.value = String(v); return; } updateFit({ [k]: pxOf(e.currentTarget.value) }); }} />
          <button type="button" class="set-fit__step" aria-label=${t('增加')} disabled=${v >= HI} onClick=${() => updateFit({ [k]: pxOf(v + 1) })}>+</button>
          <span class="set-row__val num">${fitLabel(f[k])}</span>
        </div>`;
      })}
    </div>` : null}
  </section>`;
}
