// 博士代号 (nickname): validation, the remembered name and the rename dialog. There is no title screen (the owner's
// decision of 2026-10-15: the password gate already asks for the callsign and stores it as `sp.name`, so the title was
// skipped anyway): boot connects with the remembered name — a first visit without one gets 博士 + four digits — and the
// lobby's ✎ beside the name chip opens <NameHost/>. A hello refused with NAME_REJECTED (a legacy name, a reserved one)
// sets `session.entered` false: the dialog then opens over whatever screen is up — a room or match is kept — and only a
// new valid name closes it.
//
// Saving validates the nickname (1..NAME_MAX_LEN chars, no control characters), stores it and hands it to net.js, which
// sends `hello` (now, or as soon as the socket is open); on a live socket the server renames the session and resyncs.

import { useLayoutEffect, useRef, useState } from '../../vendor/hooks.module.js';
import { NAME_MAX_LEN } from '../../../shared/constants.js';
import { html, Button, Modal, TextField } from './components.js';
import { toast } from './toasts.js';
import { net, identity } from '../net.js';
import { store, useStore } from '../store.js';
import { t } from '../../../shared/i18n.js';

// Same character classes as server/net.js sanitizeName (control, zero-width, bidi, BOM), so a name
// the client accepts is never rejected by the server's hello validation.
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g;
// Lone surrogates are removed by a scan, not a regex: the lookbehind such a regex needs is a *syntax error* in Safari
// < 16.4, which would stop the whole client from loading there.
export function stripLoneSurrogates(str) {
  let out = '';
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const n = i + 1 < str.length ? str.charCodeAt(i + 1) : 0;
      if (n >= 0xdc00 && n <= 0xdfff) { out += str[i] + str[i + 1]; i++; }
      continue;
    }
    if (c >= 0xdc00 && c <= 0xdfff) continue;
    out += str[i];
  }
  return out;
}

/**
 * Normalise a nickname like the server does (NFC, strip lone surrogates / control / invisible /
 * bidi characters, collapse whitespace, trim), then clamp to NAME_MAX_LEN UTF-16 code units — the
 * protocol's `hello.name` limit — without splitting a surrogate pair.
 * @param {any} raw
 * @returns {string}
 */
export function sanitizeName(raw) {
  let s = String(raw ?? '');
  try { s = s.normalize('NFC'); } catch { /* keep as is */ }
  s = stripLoneSurrogates(s).replace(/\s+/g, ' ').replace(CONTROL_CHARS, '').replace(/ {2,}/g, ' ').trim();
  if (s.length > NAME_MAX_LEN) {
    s = s.slice(0, NAME_MAX_LEN);
    // Don't leave half a surrogate pair at the end.
    if (/[\ud800-\udbff]$/.test(s)) s = s.slice(0, -1);
    s = s.trim();
  }
  return s;
}

/** @param {any} raw @returns {boolean} */
export const isValidName = (raw) => sanitizeName(raw).length > 0;

/** A first visit's name (no gate callsign, no remembered name): 博士 + four random digits. */
export function defaultName() {
  let n;
  try { n = globalThis.crypto.getRandomValues(new Uint16Array(1))[0] % 10000; } catch { n = Math.floor(Math.random() * 10000); }
  return sanitizeName(`${t('博士')}${String(n).padStart(4, '0')}`);
}

/**
 * Use a nickname: remember it and send it (a first hello, or a rename on the live socket).
 * @param {string} rawName
 * @returns {boolean} false when the name is invalid
 */
export function setNickname(rawName) {
  const name = sanitizeName(rawName);
  if (!name) return false;
  identity.saveName(name);
  store.set((s) => ({ me: { ...s.me, name }, session: { ...s.session, entered: true } }));
  net.setName(name);
  return true;
}

/** Open the rename dialog (the lobby's ✎). */
export const openNameDialog = () => store.patch('ui', { nameDialog: true });

/** The rename dialog; mounted once (main.js App), it opens on request or by itself after a NAME_REJECTED hello. */
export function NameHost() {
  const entered = useStore((s) => s.session.entered);
  const asked = useStore((s) => !!s.ui.nameDialog);
  return !entered || asked ? html`<${NameDialog} entered=${entered} />` : null;
}

/** @param {{ entered: boolean }} props `entered` false: a refused name — no cancel until a valid one went out */
function NameDialog({ entered }) {
  const lastError = useStore((s) => s.connection.lastError);
  const [value, setValue] = useState(() => store.get().me.name || identity.loadName() || '');
  const inputRef = useRef(null);
  // the current name selected (the Modal focused the field before this runs): typing replaces it
  useLayoutEffect(() => { inputRef.current?.select(); }, []);
  const rejected = !entered && lastError?.code === 'NAME_REJECTED';
  const valid = isValidName(value);
  const save = (e) => {
    // Enter: the closing dialog hands the focus back to ✎, which the same key would press again
    e?.preventDefault?.();
    if (!setNickname(value)) { toast(t('请输入博士代号'), 'warn'); return; }
    store.patch('ui', { nameDialog: false });
  };
  const close = entered ? () => store.patch('ui', { nameDialog: false }) : null;
  return html`<${Modal} open=${true} micro="CALLSIGN" title=${t('博士代号')} onClose=${close} closeOnBackdrop=${!!close} class="name-dialog"
    actions=${html`${close ? html`<${Button} variant="ghost" onClick=${close}>${t('取消')}<//>` : null}
      <${Button} variant="primary" disabled=${!valid} onClick=${save}>${t('确认')}<//>`}>
    <${TextField} size="lg" icon="user" value=${value} maxLength=${NAME_MAX_LEN}
      placeholder=${t('输入你的代号（最多 {NAME_MAX_LEN} 字）', { NAME_MAX_LEN })}
      inputRef=${inputRef} onInput=${setValue} onEnter=${save} invalid=${rejected} hint=${rejected ? lastError.text : null} />
  <//>`;
}
