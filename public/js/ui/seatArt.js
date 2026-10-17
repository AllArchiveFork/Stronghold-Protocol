// 名片干员: the portrait a doctor shows on the room's seat card (screens/room.js) — the operator the player picked
// (room.card; room.state seats[].card.charId), else one of the 5★/6★ operators chosen by the player id, the same on
// every client. Its art (`look`, feedback #9 / #24): '' the 精二 art, 'e1' the 精一 art, or a skin of that operator
// (lookUrl, lookOptions); the 头像 the same (`avatarLook`).
import { chessPortraitUrl } from './assetUrls.js';
import { data } from '../data.js';
import { N_ } from '../../../shared/i18n.js';

/** FNV-1a of a string (the portrait pick: the same operator for a player on every client). */
function hash32(s) {
  let h = 0x811c9dc5;
  for (const ch of String(s)) { h ^= ch.codePointAt(0); h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}

/** 名片干员: the player's own pick (localStorage; sent as room.card where the server knows it). */
export const CARD_PREF = 'room.card';

/**
 * The operators a seat card can show: one record per charId (the elite form for its E2 art), 6★ first.
 * @param {any[]} chessList chess.json records
 * @returns {any[]}
 */
export function cardOperators(chessList) {
  const by = new Map();
  for (const c of Array.isArray(chessList) ? chessList : []) {
    if (!c || c.isDiy || c.visible === false || typeof c.charId !== 'string') continue;
    const prev = by.get(c.charId);
    if (!prev || (c.isGolden && !prev.isGolden)) by.set(c.charId, c);
  }
  return [...by.values()].sort((a, b) => ((b.rarity ?? 0) - (a.rarity ?? 0)) || String(a.name).localeCompare(String(b.name), 'zh'));
}

const str = (v) => (typeof v === 'string' && v ? v : null);

/**
 * An operator's art of a card look from the art manifest alone (the lobby never downloads the operators' data):
 * `kind` 'avatar' | 'portrait'; look '' = its 精二 art when it has one (else 精一), 'e1' = 精一, a skin id = that skin's
 * art (only a skin of this operator); null when unknown.
 * @param {any} m the art manifest @param {string} charId @param {string} [look] @param {'avatar'|'portrait'} [kind]
 */
export function lookUrl(m, charId, look = '', kind = 'avatar') {
  if (typeof charId !== 'string' || !m) return null;
  if (look && look !== 'e1') {
    const s = m.skins && typeof m.skins === 'object' && Object.hasOwn(m.skins, look) ? m.skins[look] : null;
    if (s && s.charId === charId && str(s[kind])) return s[kind];
  }
  const chars = typeof m.chars === 'object' ? m.chars : null;
  const c = chars && Object.hasOwn(chars, charId) ? chars[charId] : null;
  if (!c) return null;
  return (look === 'e1' ? null : str(c[`${kind}E2`])) || str(c[kind]);
}

/**
 * The looks an operator offers on a card: [{ id, name, src }] — 精二 ('' — only when the art has an E2 form), 精一 ('e1';
 * '' when there is no E2 form, the default then) and each skin in the manifest; one entry = nothing to choose.
 * @param {any} m @param {string} charId @param {'avatar'|'portrait'} kind
 */
export function lookOptions(m, charId, kind) {
  const chars = m && typeof m.chars === 'object' ? m.chars : null;
  const c = typeof charId === 'string' && chars && Object.hasOwn(chars, charId) ? chars[charId] : null;
  if (!c) return [];
  const e2 = str(c[`${kind}E2`]);
  const out = e2 ? [{ id: '', name: N_('精英二'), src: e2 }, { id: 'e1', name: N_('精英一'), src: str(c[kind]) }]
    : [{ id: '', name: N_('精英一'), src: str(c[kind]) }];
  const skins = m.skins && typeof m.skins === 'object' ? m.skins : {};
  for (const [id, s] of Object.entries(skins)) if (s && s.charId === charId && str(s[kind])) out.push({ id, name: s.name || id, src: s[kind], skin: true });
  return out;
}

/**
 * 头像: the official avatar of an operator (room.card avatar) in its look (avatarLook: '' its elite (E2) avatar when
 * the art has one, as the card operators' golden form; 'e1'; a skin); null when unknown.
 * @param {string} charId @param {any} [m] the art manifest @param {string} [look]
 */
export function cardAvatarUrl(charId, m = data.get('assets'), look = '') {
  return lookUrl(m, charId, look, 'avatar');
}

/**
 * The seat card's portrait: the operator the player picked (room.state seats[].card, or one's own pick), else one of
 * the 5★/6★ operators chosen by the player id — the same on every client (null before the data loads).
 * @param {any} seat room.state seat @param {{ pool: any[], byChar: Map<string, any>, m: any, myId: any, myCard: string, myLook?: string }} ctx
 */
export function seatPortrait(seat, { pool, byChar, m, myId, myCard, myLook = '' }) {
  if (!seat || seat.playerId == null) return null;
  // seats[].card is { charId, bg, trophies } (ui/playerCard.js); a bare string is the design's original form
  const pick = (seat.playerId === myId && myCard) || (typeof seat.card === 'string' ? seat.card : seat.card?.charId);
  const rec = pick && byChar ? byChar.get(pick) : null;
  const mine = seat.playerId === myId && myCard;
  const look = mine ? myLook : typeof seat.card?.look === 'string' ? seat.card.look : '';
  if (rec) return (look && lookUrl(m, rec.charId, look, 'portrait')) || chessPortraitUrl(m, rec);
  if (!Array.isArray(pool) || !pool.length) return null;
  return chessPortraitUrl(m, pool[hash32(seat.playerId) % pool.length]);
}
