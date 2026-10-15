import { PHASE } from '../../../shared/constants.js';
import { html, Button, Modal } from './components.js';
import { useEffect, useRef, useState } from '../../vendor/hooks.module.js';
import { store, selectRoute } from '../store.js';
import { audio, bgmKeyFor } from '../audio.js';
import { BGM_TRACKS, BGM_CHOICES } from '../bgmChoice.js';
import { useSettings, updateSettings } from './settings.js';
import { t, N_ } from '../../../shared/i18n.js';

export const MAX_MUSIC_BYTES = 20 * 1024 * 1024;
const listeners = new Set();
let record = null, url = null, media = null, source = null, revision = 0, installed = false, dbPromise;
let status = N_('默认大厅音乐'), busy = false, lastRoute;
const notify = () => listeners.forEach(fn => fn(music.snapshot()));
let videoAudible=false;
const inMusicArea = () => { const s=store.get(),route=selectRoute(s);return ['lobby','room'].includes(route)||(route==='game'&&[PHASE.INFO_CHECK,PHASE.BAND_DRAFT,PHASE.BATTLE_CHECK].includes(s.match?.public?.phase)); };
let customGain=null,fadeTarget=0,fadeTimer,handoff=false,handoffTimer;
const areaKey = () => selectRoute(store.get()) + ':' + inMusicArea();
function db() {
  return dbPromise ||= new Promise((resolve, reject) => {
    const req = indexedDB.open('sp-lobby-music', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('tracks');
    req.onsuccess = () => { const result = req.result; result.onversionchange = () => result.close(); resolve(result); };
    req.onerror = () => { dbPromise = null; reject(Error(t('浏览器无法保存音乐，请检查可用空间'))); };
  });
}
async function saved(write, value, key = 'lobby') {
  const database = await db();
  return new Promise((resolve, reject) => {
    const tx = database.transaction('tracks', write ? 'readwrite' : 'readonly'), table = tx.objectStore('tracks');
    const req = write ? value ? table.put(value, key) : table.delete(key) : table.get(key);
    tx.oncomplete = () => resolve(req.result);
    tx.onerror = tx.onabort = () => reject(Error(t('音乐保存失败，可能是浏览器存储空间不足')));
  });
}
async function validate(file, maxSeconds = 0) {
  if (!file || file.size <= 0) throw Error(t('请选择有效的音频文件'));
  if (file.size > MAX_MUSIC_BYTES) throw Error(t('音乐不能超过 20MB，请选择较小的文件'));
  if (!/\.(mp3|wav|ogg|m4a|aac|flac|webm)$/i.test(file.name || '') || (file.type && !file.type.startsWith('audio/') && file.type !== 'video/webm' && file.type !== 'application/ogg')) throw Error(t('请选择 MP3、M4A、OGG、WAV 等音频文件'));
  const objectUrl = URL.createObjectURL(file), probe = new Audio(); probe.preload = 'metadata';
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error(t('音频读取超时，请尝试其他文件'))), 10000);
      probe.onloadedmetadata = () => {
        clearTimeout(timer);
        if (!(Number.isFinite(probe.duration) && probe.duration > 0)) reject(Error(t('音频文件无效')));
        else if (maxSeconds && probe.duration > maxSeconds) reject(Error(t('对局音乐最长 5 分钟，请选择较短的曲子')));
        else resolve();
      };
      probe.onerror = () => { clearTimeout(timer); reject(Error(t('浏览器无法播放该音频，请尝试 MP3 或 M4A'))); };
      probe.src = objectUrl;
    });
  } finally { probe.onloadedmetadata = probe.onerror = null; probe.removeAttribute('src'); probe.load(); URL.revokeObjectURL(objectUrl); }
}
function replace(next) {
  if (media) { media.pause(); media.removeAttribute('src'); media.load(); }
  if (url) URL.revokeObjectURL(url);
  record = next; url = next?.blob ? URL.createObjectURL(next.blob) : null;
  if (media && url) media.src = url;
}
function fadeCustom(on, immediate = false) {
  const target = on ? 1 : 0;
  if (target === fadeTarget && !immediate) return;
  clearTimeout(fadeTimer);fadeTarget = target;
  if (!customGain || !audio.ctx || immediate) { if (!on) media?.pause();if(customGain)customGain.gain.value=target;return; }
  const t=audio.ctx.currentTime,g=customGain.gain;
  if (g.cancelAndHoldAtTime) g.cancelAndHoldAtTime(t);
  else {g.cancelScheduledValues(t);g.setValueAtTime(g.value,t);}
  g.linearRampToValueAtTime(target,t+0.9);
  if (!on) fadeTimer=setTimeout(()=>{if(fadeTarget===0){media.pause();notify();}},1000);
}
function clearHandoff() { clearTimeout(handoffTimer);handoff=false; }
function sync() {
  if (!media || !record) return;
  if ((videoAudible&&selectRoute(store.get())==='lobby') || !record.enabled || record.paused || document.hidden || audio.bgmSilent) {clearHandoff();fadeCustom(false,true);return;}
  if (!inMusicArea()) {
    // Keep the old music while the next game's BGM buffer is loading.
    if (selectRoute(store.get())==='game' && !media.paused && fadeTarget>0) {
      if (!handoff) {handoff=true;handoffTimer=setTimeout(()=>{clearHandoff();fadeCustom(false);},10000);}
    } else fadeCustom(false);
    return;
  }
  clearHandoff();
  if (!audio.ctx) return;
  if (!source) {source=audio.ctx.createMediaElementSource(media);customGain=audio.ctx.createGain();customGain.gain.value=0;source.connect(customGain);customGain.connect(audio.bgmGain);}
  fadeCustom(true);
  if (!media.paused) return;
  media.play().then(()=>{status=t('正在播放 · 单曲循环');notify();},()=>{status=t('点击“播放”开始音乐');notify();});
}

function refresh() {
  const s = store.get(); audio.playBgm(bgmKeyFor(selectRoute(s), s.match?.public)); sync(); notify();
}
function install() {
  if (installed) return; installed = true;
  media = new Audio(); media.loop = true; media.preload = 'none';
  media.onerror = () => { record && (record.enabled = false); status = t('音乐播放失败，已恢复默认音乐'); refresh(); };
  audio.lobbyMusicOverride = key => {
    const override = key === 'lobby' && ((videoAudible&&selectRoute(store.get())==='lobby') || (record?.enabled&&inMusicArea()));
    sync();
    return !!override;
  };
  audio.lobbyMusicBgmStarted = () => { if (!inMusicArea()) {clearHandoff();fadeCustom(false);} };
  window.addEventListener('sp:lobby-video-audio', e => {videoAudible=!!e.detail?.active;refresh();});
  lastRoute = areaKey();
  store.subscribe(() => { const route = areaKey(); if (route !== lastRoute) { lastRoute = route; refresh(); } else sync(); });
  document.addEventListener('visibilitychange', sync);
  window.addEventListener('pointerdown', () => { if (record?.enabled) { audio._unlock(); sync(); } }, { passive: true });
  const initialRevision = revision;
  saved(false).then(value => {
    if (revision !== initialRevision || !value?.blob || value.blob.size > MAX_MUSIC_BYTES) return;
    replace(value); status = value.paused ? t('已暂停') : t('点击“播放”开始音乐'); refresh();
  }).catch(() => { status = t('浏览器暂不能保存音乐，可稍后重试'); notify(); });
}
export const music = {
  snapshot: () => ({ name: record?.name || '', size: record?.blob?.size || 0, enabled: !!record?.enabled, paused: !!record?.paused, playing: !!media && !media.paused, status, busy }),
  async upload(file) {
    if (busy) return; install(); ++revision; busy = true; notify();
    try { await validate(file); const next = { blob: file, name: file.name.slice(0,180), enabled: true, paused: false }; await saved(true, next); replace(next); status = t('已保存音乐'); audio._unlock(); refresh(); }
    catch(e) { status = e.message || t('音乐导入失败'); throw e; }
    finally { busy = false; notify(); }
  },
  async toggle() {
    if (!record || busy) return; ++revision;
    const next = { ...record, enabled: true, paused: !!record.enabled && !media.paused };
    await saved(true,next); record=next; status=next.paused?t('已暂停'):t('正在播放 · 单曲循环'); audio._unlock(); refresh();
  },
  async reset() { if (busy) return; ++revision; await saved(true,null); replace(null); status=t('默认大厅音乐'); refresh(); },
};
// 对局音乐 (the owner's request of 2026-10-15): the 休整期 / 作战 BGM, official by default — bgmChoice.js, settings
// bgmPrep / bgmCombat. 休整期 offers every track but its own official one (that is 官方); 作战's 官方 is the round table.
// 自选曲 is a file of the player's, one per kind, kept like the lobby music (the same IndexedDB store, keys 'prep' /
// 'combat'; nothing goes to a server) and handed to audio.js as an object URL. It is decoded whole like the official
// tracks (the lobby music streams), so it may last MAX_MATCH_MUSIC_S at most: 5 minutes are ~115 MB of PCM.
export const MAX_MATCH_MUSIC_S = 300;
const MATCH_KINDS = ['prep', 'combat'];
const matchFiles = { prep: null, combat: null }, matchUrls = { prep: null, combat: null }, matchRev = { prep: 0, combat: 0 };
const matchListeners = new Set();
let matchLoaded = false;
function setMatchFile(kind, rec) {
  const old = matchUrls[kind];
  matchFiles[kind] = rec;
  matchUrls[kind] = rec?.blob ? URL.createObjectURL(rec.blob) : null;
  audio.setBgmLocal(kind, matchUrls[kind]);
  if (old) URL.revokeObjectURL(old);
  matchListeners.forEach((fn) => fn());
}
export const matchMusic = {
  /** Hand the saved files to audio.js (main.js boot: a page that resumes a match never opens the lobby). */
  load() {
    if (matchLoaded) return;
    matchLoaded = true;
    for (const kind of MATCH_KINDS) {
      const rev = matchRev[kind];
      saved(false, undefined, kind).then((v) => {
        if (rev === matchRev[kind] && v?.blob && v.blob.size <= MAX_MUSIC_BYTES) setMatchFile(kind, v);
      }).catch(() => {});
    }
  },
  name: (kind) => matchFiles[kind]?.name || '',
  async upload(kind, file) {
    ++matchRev[kind];
    await validate(file, MAX_MATCH_MUSIC_S);
    const rec = { blob: file, name: file.name.slice(0, 180) };
    await saved(true, rec, kind);
    setMatchFile(kind, rec);
    audio._unlock();
  },
  async remove(kind) { ++matchRev[kind]; await saved(true, null, kind); setMatchFile(kind, null); },
};
const PREP_PICKS = BGM_CHOICES.filter((id) => id !== 'prep');
const trackName = (id) => (id === 'official' ? t('官方（默认）') : id === 'custom' ? t('自选曲') : t(BGM_TRACKS.find((x) => x.id === id)?.name || id));
function BgmPick({ kind, label, value, options, onPick, busy, action }) {
  const input = useRef(null);
  const name = matchMusic.name(kind);
  return html`<div style="display:grid;gap:6px;min-width:0">
    <label style="display:grid;grid-template-columns:4.5em minmax(0,1fr);align-items:center;gap:10px;font-size:13px">
      <span>${label}</span>
      <span class="lang-select" style="display:block;min-width:0"><select data-testid=${`bgm-${kind}`} style="width:100%" value=${value} onChange=${(e) => onPick(e.currentTarget.value)}>
        ${options.map((id) => html`<option key=${id} value=${id}>${trackName(id)}</option>`)}
      </select></span>
    </label>
    ${value === 'custom' ? html`<div style="display:flex;align-items:center;gap:8px;padding-left:calc(4.5em + 10px);min-width:0">
      <small data-testid=${`bgm-${kind}-file`} style="flex:1;min-width:0;font-size:12px;overflow-wrap:anywhere;color:${name ? 'var(--mint,#58d9b5)' : 'var(--muted)'}">${name || t('未选择文件')}</small>
      <input ref=${input} type="file" accept="audio/*,.mp3,.m4a,.ogg,.wav,.aac,.flac,.webm" hidden onChange=${(e) => { const file = e.currentTarget.files?.[0]; e.currentTarget.value = ''; if (file) action(() => matchMusic.upload(kind, file)); }} />
      <${Button} size="sm" disabled=${busy} onClick=${() => input.current?.click()}>${busy ? t('正在导入…') : name ? t('更换') : t('选择文件')}<//>
      ${name ? html`<${Button} size="sm" variant="secondary" disabled=${busy} onClick=${() => action(async () => { await matchMusic.remove(kind); onPick('official'); })}>${t('清除')}<//>` : null}
    </div>` : null}
  </div>`;
}
function MatchMusic() {
  const s = useSettings();
  const [, setRev] = useState(0), [busy, setBusy] = useState(false), [error, setError] = useState('');
  useEffect(() => { const fn = () => setRev((n) => n + 1); matchListeners.add(fn); return () => matchListeners.delete(fn); }, []);
  const action = async (fn) => {
    setError(''); setBusy(true);
    try { await fn(); } catch (e) { setError(e.message || t('音乐导入失败')); } finally { setBusy(false); }
  };
  return html`<div style="display:grid;gap:10px;padding-top:14px;border-top:1px solid rgba(223,230,226,.14);min-width:0">
    <strong style="font-size:15px">${t('对局音乐')}</strong>
    <${BgmPick} kind="prep" label=${t('休整期')} value=${s.bgmPrep} options=${PREP_PICKS} busy=${busy} action=${action} onPick=${(v) => updateSettings({ bgmPrep: v })} />
    <${BgmPick} kind="combat" label=${t('作战')} value=${s.bgmCombat} options=${BGM_CHOICES} busy=${busy} action=${action} onPick=${(v) => updateSettings({ bgmCombat: v })} />
    ${error ? html`<p role="alert" style="margin:0;color:#ff9393;font-size:13px;overflow-wrap:anywhere">${error}</p>` : null}
    <small style="color:var(--muted);font-size:12px;line-height:1.6">${t('只改变你自己听到的音乐。自选曲保存在当前浏览器，每首最长 5 分钟。作战的官方音乐：第 1–7 回合《无畏者》，第 8 回合起《骑士之日》；联防、最终攻势和隐秘核心保持官方音乐。')}</small>
  </div>`;
}

export function LobbyMusicButton() {
  const [open,setOpen]=useState(false),[state,setState]=useState(music.snapshot),[error,setError]=useState('');const input=useRef(null);
  useEffect(()=>{install();const fn=s=>setState(s);listeners.add(fn);fn(music.snapshot());return()=>listeners.delete(fn);},[]);
  const action=async fn=>{setError('');try{await fn();}catch(e){setError(e.message||t('操作失败'));}};
  return html`<${Button} variant="secondary" size="sm" square=${true} class="hub-music-btn" title=${t('音乐')} aria-label=${t('音乐')} onClick=${()=>setOpen(true)}><span style="font-size:22px;line-height:1" aria-hidden="true">♫</span><//>
    <style>.lobby-music-panel .modal__head{padding:14px 16px 4px}.lobby-music-panel .modal__title{font-size:18px}.lobby-music-panel .modal__head>:first-child{font-size:10px}.lobby-music-panel .modal__body{padding:12px 16px 16px}.lobby-music-panel .modal__actions{padding:10px 16px}.lobby-music-panel button{font-size:13px;min-height:36px;padding:8px 12px}.lobby-music-panel select{height:36px;font-size:13px}@media (pointer: coarse){.lobby-music-panel select{height:44px;font-size:16px}}</style>
    <${Modal} class="lobby-music-panel" open=${open} title=${t('音乐')} micro="MUSIC" width="min(420px, calc(100vw - 32px))" onClose=${()=>setOpen(false)} actions=${html`<${Button} variant="secondary" onClick=${()=>setOpen(false)}>${t('关闭')}<//>`}>
      <div style="display:grid;gap:14px;padding:8px 0;min-width:0">
        <strong style="font-size:15px">${t('大厅音乐')}</strong>
        <p style="margin:0;color:var(--muted);font-size:13px;line-height:1.7">${t('选择你喜欢的大厅音乐，每首最大 20MB。保存在当前浏览器，无需上传服务器；房间、战前信息和选人时继续播放，进入战场淡出并切换游戏音乐。')}</p>
        <div style="padding:14px;border:1px solid var(--mint,#58d9b5);background:rgba(30,90,75,.12);min-width:0">
          <strong style="display:block;font-size:15px;overflow-wrap:anywhere">${state.name||t('默认大厅音乐')}</strong>
          <small style="display:block;font-size:12px;margin-top:8px;color:var(--mint,#58d9b5)">${t(state.status)}${state.size?` · ${(state.size/1024/1024).toFixed(1)} MB`:''}</small>
        </div>
        <input ref=${input} type="file" accept="audio/*,.mp3,.m4a,.ogg,.wav,.aac,.flac,.webm" hidden onChange=${e=>{const file=e.currentTarget.files?.[0];e.currentTarget.value='';if(file)action(()=>music.upload(file));}} />
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <${Button} disabled=${state.busy} onClick=${()=>input.current?.click()}>${state.busy?t('正在导入…'):t('上传音乐')}<//>
          <${Button} disabled=${!state.name||state.busy} onClick=${()=>action(()=>music.toggle())}>${state.playing?t('暂停'):t('播放')}<//>
          <${Button} disabled=${!state.name||state.busy} variant="secondary" onClick=${()=>action(()=>music.reset())}>${t('恢复默认')}<//>
        </div>
        <small style="color:var(--muted);font-size:12px;line-height:1.6">${t('音量和静音沿用游戏设置。刷新后保留；清理浏览器数据会删除音乐。')}</small>
        ${error?html`<p role="alert" style="margin:0;color:#ff9393;overflow-wrap:anywhere">${error}</p>`:null}
        <${MatchMusic} />
      </div>
    <//>`;
}
