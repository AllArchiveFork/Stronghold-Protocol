// 服主 mark (2026-10-14, the owner's decision): the server marks a verified owner's seat and spectator seat
// (room.state seats[].owner / spectators[].owner — server: SP_OWNER_FILE and the key in hello.owner, ../ownerKey.js) and
// keeps the owner's nicknames for the owner alone. The client never decides it from a name. 服主验证 in 设置 keeps the key
// on the owner's own browser; it shows with #owner in the address, or while a key is kept.
import { useState } from '../../vendor/hooks.module.js';
import { html, Button, Icon } from './components.js';
import { useStore } from '../store.js';
import { ownerKey, setOwnerKey, OWNER_KEY_MAX } from '../ownerKey.js';
import { t } from '../../../shared/i18n.js';

/** Whether a room.state seat / spectator is the verified owner. */
export const isOwnerSeat = (s) => !!s && s.owner === true && !s.isBot;

/** The 服主 badge after a name. */
export function OwnerBadge({ seat, class: cls = '' }) {
  if (!isOwnerSeat(seat)) return null;
  return html`<span class=${`sp-owner-badge ${cls}`} title=${t('服主')}><${Icon} name="crown" />${t('服主')}</span>`;
}

/** 设置 → 服主验证 (only for the owner's browser: #owner in the address, or a key already kept). */
export function OwnerKeySection() {
  const verified = useStore((s) => s.me?.owner === true);
  const [kept, setKept] = useState(() => !!ownerKey());
  const [value, setValue] = useState('');
  const [shown] = useState(() => kept || globalThis.location?.hash === '#owner');
  if (!shown) return null;
  const save = () => { setOwnerKey(value); setKept(!!ownerKey()); setValue(''); };
  const clear = () => { setOwnerKey(null); setKept(false); };
  return html`<section class="set-owner">
    <h4>${t('服主验证')}</h4>
    <p class="set-hint">${verified ? t('已验证为服主：你的席位会显示服主标记') : kept ? t('服主密钥已保存在本机，刷新页面后由服务器验证') : t('输入服主密钥后保存在本机，之后每次连接由服务器验证')}</p>
    <div class="set-owner__row">
      <input type="password" autocomplete="off" spellcheck="false" maxlength=${OWNER_KEY_MAX} value=${value} placeholder=${kept ? t('已保存（输入新密钥可替换）') : t('服主密钥')}
        onInput=${(e) => setValue(e.currentTarget.value)} />
      <${Button} size="sm" variant="secondary" disabled=${!value.trim()} onClick=${save}>${t('保存')}<//>
      ${kept ? html`<${Button} size="sm" variant="ghost" onClick=${clear}>${t('清除')}<//>` : null}
    </div>
  </section>`;
}
