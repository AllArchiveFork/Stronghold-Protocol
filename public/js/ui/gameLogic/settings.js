// ui/gameLogic/settings.js — settings defaults and sanitising. Re-exported from ../gameLogic.js.

import { VOICE_LANGS, sanitizeVoiceOverrides } from '../../voicePrefs.js';
import { sanitizeBgmChoice } from '../../bgmChoice.js';
export { VOICE_LANGS } from '../../voicePrefs.js';

import { clamp, isObj } from './shared.js';
import { DEFAULT_HOTKEYS, sanitizeHotkeys } from './shortcuts.js';


// ---- settings ------------------------------------------------------------------------------------------------------

/**
 * The listener's voice preference, mirrored from the shared language control (ui/languageSettings.js): 'cn' 中文
 * (`audio.voice`, the default), 'jp' 日本語 (`audio.voiceJp`), 'en' English (`audio.voiceEn`) and 'kr' 한국어
 * (`audio.voiceKr`), each falling back to the Chinese line it lacks (public/js/audio.js voiceLine). Not tied to the
 * interface language. `voiceNative` is the 本土语言 switch: an operator who has `audio.voiceNative` speaks that dub
 * unless their own override says otherwise.
 */


/**
 * The steps of 设置 →「文字大小」 (textSize): the interface text root `--t` of css/theme.css — 'sm' is the design's own
 * sizes (`--t: 1rem`), the others lift the phone's 40 px root by a floor and grow the desktop gently. Text only: the
 * layout root `1rem` (and with it the field camera, the detail card's side and the DOM fallback board) never moves.
 */
export const TEXT_SIZES = Object.freeze(['sm', 'md', 'lg', 'xl']);

/**
 * The steps of 设置 →「界面大小」 (uiScale): css/theme.css `--ui`, the factor of the match's layout root and pixel floors
 * (the lobby and the other screens never scale). 'auto' is 80 % on a phone (UI_SCALE_PHONE; the phone query of
 * css/devices.css, ui/teamLayout.js PHONE_QUERY) and 100 % elsewhere; the others are the percentage.
 */
export const UI_SCALES = Object.freeze(['auto', '70', '80', '90', '100', '110', '120']);
export const UI_SCALE_PHONE = '80';

/**
 * The step 界面大小 shows as chosen: the stored one, or what 'auto' resolves to on this device.
 * @param {string} uiScale @param {boolean} phone
 */
export function uiScaleStep(uiScale, phone) {
  if (uiScale !== 'auto' && UI_SCALES.includes(uiScale)) return uiScale;
  return phone ? UI_SCALE_PHONE : '100';
}

/** keys: the in-match shortcuts' key map (ui/gameLogic/shortcuts.js; settings → 快捷键). voiceLang: VOICE_LANGS.
 *  voiceNative: the 本土语言 switch (default off). textSize: TEXT_SIZES (css/theme.css `--t`, applied by ui/settings.js
 *  applyTextSize). uiScale: UI_SCALES (`--ui`, applied by ui/settings.js applyUiScale). ammoCount: 设置「弹药数量」 — the
 *  rounds left / the magazine under an ammo skill's bar (render/units.js; PR #552), off by default: the official HUD has
 *  no such number (the maintainer's decision of 2026-10-13).
 *  combatMetrics: 设置「作战统计」 (PR #618), off by default: the official HUD has no such panel.
 *  mysticEnergy: 设置「秘术师能量」 (PR #636) — a 秘术师's stored attack energies as stored/cap under the bars
 *  (render/units.js), off by default: the official HUD shows them as an effect on the operator, not a number (the
 *  maintainer's decision of 2026-10-15).
 *  officialFx: 设置「官方特效」 (0.3.0, render/vfx): 'full' (完整, this fork's default on every device — the owner's
 *  decision of 2026-10-16), 'auto' (完整 on a desktop, 精简 on a touch device — render/vfx/tier.js), 'off', 'lite'
 *  (精简); only shown when effects were extracted from the local client.
 *  bgmPrep / bgmCombat: the 休整期 / 作战 BGM picked in the lobby's ♫ panel (bgmChoice.js; 'official' = the mode's own
 *  music). */
export const DEFAULT_SETTINGS = Object.freeze({ bgm: 0.6, sfx: 0.8, voice: 0.8, voiceLang: 'cn', voiceNative: false, voiceOverrides: Object.freeze({}), muted: false, damageNumbers: true, officialDamageNumbers: false, ammoCount: false, combatMetrics: false, mysticEnergy: false, quality: 'high', officialFx: 'full', textSize: 'sm', uiScale: 'auto', keys: DEFAULT_HOTKEYS, bgmPrep: 'official', bgmCombat: 'official' });
const QUALITIES = ['high', 'medium', 'low'];
/** The values of 设置「官方特效」 (render/vfx/tier.js OFFICIAL_FX). */
export const OFFICIAL_FX_MODES = Object.freeze(['auto', 'off', 'lite', 'full']);

/**
 * Sanitize persisted settings.
 * @param {any} raw
 * @returns {{ bgm: number, sfx: number, voice: number, voiceLang: 'cn'|'jp'|'en'|'kr', voiceNative: boolean, voiceOverrides: Record<string, string>, muted: boolean, damageNumbers: boolean, officialDamageNumbers: boolean, ammoCount: boolean, combatMetrics: boolean, mysticEnergy: boolean, quality: 'high'|'medium'|'low', officialFx: 'auto'|'off'|'lite'|'full',
 *   textSize: 'sm'|'md'|'lg'|'xl', uiScale: string, keys: Record<'buy'|'refresh'|'freeze'|'levelUp'|'retreat'|'sell'|'ready', string>, bgmPrep: string, bgmCombat: string }}
 */
export function sanitizeSettings(raw) {
  const r = isObj(raw) ? raw : {};
  const vol = (v, d) => (Number.isFinite(v) ? clamp(Math.round(v * 100) / 100, 0, 1) : d);
  return {
    bgm: vol(r.bgm, DEFAULT_SETTINGS.bgm),
    sfx: vol(r.sfx, DEFAULT_SETTINGS.sfx),
    voice: vol(r.voice, DEFAULT_SETTINGS.voice),
    voiceLang: VOICE_LANGS.includes(r.voiceLang) ? r.voiceLang : DEFAULT_SETTINGS.voiceLang,
    voiceNative: r.voiceNative === true,
    voiceOverrides: sanitizeVoiceOverrides(r.voiceOverrides),
    muted: typeof r.muted === 'boolean' ? r.muted : DEFAULT_SETTINGS.muted,
    damageNumbers: typeof r.damageNumbers === 'boolean' ? r.damageNumbers : DEFAULT_SETTINGS.damageNumbers,
    officialDamageNumbers: typeof r.officialDamageNumbers === 'boolean' ? r.officialDamageNumbers : false,
    ammoCount: typeof r.ammoCount === 'boolean' ? r.ammoCount : DEFAULT_SETTINGS.ammoCount,
    combatMetrics: typeof r.combatMetrics === 'boolean' ? r.combatMetrics : DEFAULT_SETTINGS.combatMetrics,
    mysticEnergy: typeof r.mysticEnergy === 'boolean' ? r.mysticEnergy : DEFAULT_SETTINGS.mysticEnergy,
    quality: QUALITIES.includes(r.quality) ? r.quality : DEFAULT_SETTINGS.quality,
    officialFx: OFFICIAL_FX_MODES.includes(r.officialFx) ? r.officialFx : DEFAULT_SETTINGS.officialFx,
    textSize: TEXT_SIZES.includes(r.textSize) ? r.textSize : DEFAULT_SETTINGS.textSize,
    uiScale: UI_SCALES.includes(String(r.uiScale)) ? String(r.uiScale) : DEFAULT_SETTINGS.uiScale,
    keys: sanitizeHotkeys(r.keys),
    bgmPrep: sanitizeBgmChoice(r.bgmPrep),
    bgmCombat: sanitizeBgmChoice(r.bgmCombat),
  };
}
