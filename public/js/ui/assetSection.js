// 设置 → 素材下载 (fork, 2026-10-16: the owner's request for players on weak networks). The upstream download queue
// (assetDownload.js, the title screen's 下载完整素材 until the title screen went on 2026-10-15) reads the art through the
// page's service worker, which keeps it by path in Cache Storage for the release's material profile (public/sw.js): later
// loads come from the browser, not the network. The files still come from the material providers (ModelScope first),
// never from this server's own bandwidth. Two tiers (selectAssetTier): 对局素材 — no skins, only the dubs this player
// hears — or 全部素材. The queue goes on while the settings are closed, pauses itself when a match starts and goes on
// back in the lobby or a room. A material load that gives no sign of life in time (materialFallback.js onMaterialSlow)
// suggests this section once per session. Not offered: upstream's 导入素材包 — its imported art answers only the
// content-hashed asset URLs, and this server serves the plain ones (SP_ASSET_INDEX=0).
import { useEffect, useState } from '../../vendor/hooks.module.js';
import { html, Button, MicroLabel, ProgressBar } from './components.js';
import { assetDownload } from '../assetDownload.js';
import { askPersistStorage, storageEstimate } from '../assetCache.js';
import { onMaterialSlow } from '../materialFallback.js';
import { createStore, loadPref, savePref, selectRoute, store, useStore } from '../store.js';
import { toast } from './toasts.js';
import { t } from '../../../shared/i18n.js';

/** Approximate sizes of the tiers for the 0.3.0 material set, in GB (shown as「约 …」; the queue counts files). */
export const ASSET_TIER_GB = Object.freeze({ match: 0.8, all: 2.6 });
const BUSY = ['preparing', 'downloading'];

/** Whether this page's service worker keeps fetched art (registered with the material profile: public/sw.js). */
export function keepsArt(nav = globalThis.navigator) {
  try { return new URL(nav.serviceWorker.controller.scriptURL).searchParams.has('material'); } catch { return false; }
}

// paused by a starting match (so resumed after it), not by the player
const matchPause = createStore({ on: false });
let watching = false;

function watch() {
  if (watching) return;
  watching = true;
  let route = selectRoute(store.get());
  store.subscribe((s) => {
    const next = selectRoute(s);
    if (next === route) return;
    route = next;
    if (next === 'game' && BUSY.includes(assetDownload.get().phase)) {
      matchPause.set({ on: true });
      assetDownload.pause();
    } else if (next !== 'game' && matchPause.get().on) {
      matchPause.set({ on: false });
      void assetDownload.start();
    }
  });
  let phase = assetDownload.get().phase;
  assetDownload.subscribe((state) => {
    if (state.phase === phase) return;
    phase = state.phase;
    if (phase === 'complete') toast(t('素材下载完成，之后进入对局会直接读取本地素材'), 'success');
    else if (phase === 'partial') toast(t('素材下载结束，有 {n} 个文件失败，可以在「设置 → 素材下载」重试', { n: state.failures.length }), 'warn');
  });
}

/** Start (or go on with) a download of `tier`. @param {{ tier: string, voice?: string, native?: boolean }} choice */
export function startAssetDownload(choice) {
  watch();
  matchPause.set({ on: false });
  void askPersistStorage();
  return assetDownload.start(choice);
}

/** The once-per-session hint of a slow material load (call once from boot). @returns {() => void} */
export function installAssetHints({ notify = toast, keeps = keepsArt } = {}) {
  let hinted = false;
  return onMaterialSlow(() => {
    if (hinted || !keeps() || [...BUSY, 'complete'].includes(assetDownload.get().phase)) return;
    hinted = true;
    try {
      if (globalThis.sessionStorage?.getItem('sp.assetHint')) return;
      globalThis.sessionStorage?.setItem('sp.assetHint', '1');
    } catch { /* hint anyway */ }
    notify(t('素材加载较慢。可以在「设置 → 素材下载」提前下载素材，之后进入对局直接读取。'), 'info', { ttl: 10000 });
  });
}

const gb = (bytes) => (bytes / 1e9).toFixed(1);

/** The settings section. @param {{ voice: string, native: boolean }} props the player's dubs (settings) */
export function AssetSection({ voice, native }) {
  const [state, setState] = useState(() => assetDownload.get());
  const [tier, setTier] = useState(() => (loadPref('assetTier', 'match') === 'all' ? 'all' : 'match'));
  const [space, setSpace] = useState(null);
  const inMatch = useStore((s) => selectRoute(s) === 'game');
  const pausedForMatch = useStore((s) => s.on, Object.is, matchPause);
  const [keeps] = useState(() => keepsArt());
  useEffect(() => assetDownload.subscribe(setState), []);
  useEffect(() => {
    let live = true;
    storageEstimate().then((est) => { if (live) setSpace(est); });
    return () => { live = false; };
  }, [state.phase === 'complete']);
  const busy = BUSY.includes(state.phase);
  const choose = (id) => { if (busy) return; setTier(id); savePref('assetTier', id); };
  const begin = () => { void startAssetDownload({ tier, voice, native }); };
  const free = space && space.quota > 0 ? space.quota - space.usage : null;
  const status = state.phase === 'preparing' ? t('正在读取素材清单…')
    : state.phase === 'downloading' ? t('正在下载素材…')
      : state.phase === 'paused' ? (pausedForMatch ? t('对局中已暂停，回到大厅后自动继续') : t('素材下载已暂停'))
        : state.phase === 'complete' ? t('素材已下载完成')
          : state.phase === 'partial' ? t('有 {n} 个素材下载失败', { n: state.failures.length })
            : state.phase === 'error' ? t('无法读取素材清单，请检查网络后重试。') : null;
  const action = busy ? html`<${Button} variant="ghost" size="sm" data-testid="asset-pause" onClick=${() => { matchPause.set({ on: false }); assetDownload.pause(); }}>${t('暂停')}<//>`
    : html`<${Button} variant="primary" size="sm" data-testid="asset-start" disabled=${inMatch} onClick=${begin}>${
      state.phase === 'paused' ? t('继续下载') : state.phase === 'complete' ? t('重新检查')
        : ['partial', 'error'].includes(state.phase) ? t('重试') : t('开始下载')}<//>`;
  return html`<section class="set-assets" aria-labelledby="set-assets-title" data-testid="asset-section">
    <div class="set-keys__head">
      <span class="set-row__label" id="set-assets-title">${t('素材下载')}<${MicroLabel}>ASSETS<//></span>
      ${action}
    </div>
    <p class="set-hint">${t('网络较慢时，可以先把素材下载到浏览器，之后进入对局直接读取，不用边玩边等。素材从 ModelScope 下载，建议使用 Wi-Fi；关闭设置后继续下载，进入对局时自动暂停，回到大厅后继续。')}</p>
    <div class="set-seg set-assets__tier" role="radiogroup" aria-label=${t('下载范围')}>
      <button type="button" role="radio" aria-checked=${tier === 'match' ? 'true' : 'false'} class=${tier === 'match' ? 'is-on' : ''}
        disabled=${busy} data-testid="asset-tier-match" onClick=${() => choose('match')}>
        <b>${t('对局素材')}</b><small>${t('约 {gb} GB · 不含皮肤，只含正在使用的配音', { gb: ASSET_TIER_GB.match })}</small></button>
      <button type="button" role="radio" aria-checked=${tier === 'all' ? 'true' : 'false'} class=${tier === 'all' ? 'is-on' : ''}
        disabled=${busy} data-testid="asset-tier-all" onClick=${() => choose('all')}>
        <b>${t('全部素材')}</b><small>${t('约 {gb} GB · 含全部皮肤和配音', { gb: ASSET_TIER_GB.all })}</small></button>
    </div>
    ${state.total > 0 ? html`<${ProgressBar} value=${state.done} max=${state.total} class="set-assets__bar"
      label=${t('已完成 {done} / {total} 个文件', { done: state.done, total: state.total })} />` : null}
    ${status ? html`<p class=${state.phase === 'partial' || state.phase === 'error' ? 'set-keys__note is-warn' : 'set-keys__note'}
      role="status" aria-live="polite" data-testid="asset-status">${status}${state.bytes > 0 ? html` · ${t('已读取 {size} MB', { size: Math.round(state.bytes / 1048576) })}` : null}</p>` : null}
    ${inMatch && !busy && !pausedForMatch ? html`<p class="set-hint">${t('对局中不下载素材，回到大厅后再开始。')}</p>` : null}
    ${!keeps ? html`<p class="set-hint is-warn" data-testid="asset-no-keep">${t('这个页面还不能把素材保存在本地（浏览器不支持，或需要刷新一次页面），下载的素材可能不会保留。')}</p>` : null}
    ${free !== null && free < ASSET_TIER_GB[tier] * 1e9 ? html`<p class="set-hint is-warn">${t('浏览器可用空间约 {gb} GB，可能放不下这一档素材。', { gb: gb(free) })}</p>` : null}
    <p class="set-hint">${t('素材更新后需要重新下载；清除浏览器数据也会删掉已下载的素材。')}</p>
  </section>`;
}
