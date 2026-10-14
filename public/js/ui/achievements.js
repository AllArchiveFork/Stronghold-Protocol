// 成就统计 (2026-10-14: the panel of the lobby design by 雨千代chiyo, rebuilt on this browser's 统计数据 — the owner's
// decision: no accounts, so everything here is local and per browser, like 统计数据 itself, ui/stats.js): the hub's entry
// card (the trophy level, how many achievements are reached) and the panel — the name card (名片底图 / 名片干员,
// ui/playerCard.js), 已获奖杯 and the trophy level, the mode table (独立 / 同盟: games, wins, best round), the 成就 list
// (ACHIEVEMENTS, each with its progress), 策略纪录 (the strategies played most) and 评语纪录 (the titles received).
// Nothing is sent anywhere; the trophy level travels with room.card (display only).
// Styles: css/screens/lobby.css (.hub-ach / .ach*).
import { useEffect, useMemo, useState } from '../../vendor/hooks.module.js';
import { DIFFICULTIES } from '../../../shared/constants.js';
import { html, Icon, MicroLabel, doctorNo } from './components.js';
import { Img, BandIcon, useGameData } from './gameComponents.js';
import { titleIconUrl, chessAvatarUrl } from './assetUrls.js';
import { peekStatsRecords, aggregateStats, countsTowardStats, selfRowOf } from './stats.js';
import { TrophyBadge, trophyLevel } from './trophies.js';
import { NameCardLayer, NameCardPicker } from './namecards.js';
import { useMyCard, trophyTotal, setCardBackground } from './playerCard.js';
import { Emblem } from '../screens/title.js';
import { t, N_ } from '../../../shared/i18n.js';

const fmt = (n) => (Number.isFinite(n) ? Math.round(n).toLocaleString('zh-CN') : '0');

/**
 * The numbers the achievements read, from the stats records (only the records that count, ui/stats.js
 * countsTowardStats; the trophies from every settled record).
 * @param {any[]} records
 */
export function progressOf(records) {
  const all = Array.isArray(records) ? records : [];
  const agg = aggregateStats(all);
  const modes = { solo: { games: 0, wins: 0, best: 0 }, coop: { games: 0, wins: 0, best: 0 } };
  for (const rec of all.filter(countsTowardStats)) {
    const m = modes[rec.roomMode];
    if (!m) continue;
    const self = selfRowOf(rec);
    m.games++;
    if (self ? self.victory : rec.victory) m.wins++;
    const r = Number.isFinite(self?.roundsPassed) ? self.roundsPassed : rec.roundsPassed;
    if (Number.isFinite(r)) m.best = Math.max(m.best, r);
  }
  const winsAt = (d) => agg.byDifficulty[d]?.wins || 0;
  return {
    agg, modes, trophies: trophyTotal(all),
    games: agg.count, wins: agg.wins, hours: agg.duration.totalMs / 3.6e6,
    clears: Object.fromEntries(DIFFICULTIES.map((d) => [d, winsAt(d)])),
    hidden: agg.hidden.cleared, hiddenAbyss: agg.byDifficulty.ABYSS?.hiddenCleared || 0,
    bandKinds: Object.keys(agg.bands).length, titleKinds: Object.keys(agg.titles).length,
    sums: agg.sums,
  };
}

/**
 * The achievements (the owner reviews this list; 2026-10-14 first draft): `value(p)` reads progressOf, reached at `goal`.
 * Groups: 模拟经历 / 胜利 / 难度 / 同盟 / 策略 / 战斗 / 奖杯.
 */
export const ACHIEVEMENTS = Object.freeze([
  { id: 'games_1', group: 'career', name: N_('初次模拟'), desc: N_('完成 1 场模拟'), goal: 1, value: (p) => p.games },
  { id: 'games_10', group: 'career', name: N_('例行演练'), desc: N_('完成 10 场模拟'), goal: 10, value: (p) => p.games },
  { id: 'games_50', group: 'career', name: N_('久经推演'), desc: N_('完成 50 场模拟'), goal: 50, value: (p) => p.games },
  { id: 'games_200', group: 'career', name: N_('卫戍常驻'), desc: N_('完成 200 场模拟'), goal: 200, value: (p) => p.games },
  { id: 'hours_10', group: 'career', name: N_('长时值守'), desc: N_('累计模拟 10 小时'), goal: 10, value: (p) => Math.floor(p.hours) },
  { id: 'wins_1', group: 'victory', name: N_('初战告捷'), desc: N_('取得 1 场胜利'), goal: 1, value: (p) => p.wins },
  { id: 'wins_20', group: 'victory', name: N_('屡战屡胜'), desc: N_('取得 20 场胜利'), goal: 20, value: (p) => p.wins },
  { id: 'wins_100', group: 'victory', name: N_('百战不殆'), desc: N_('取得 100 场胜利'), goal: 100, value: (p) => p.wins },
  { id: 'clear_FUNNY', group: 'difficulty', name: N_('标准达成'), desc: N_('在标准模拟中获胜'), goal: 1, value: (p) => p.clears.FUNNY },
  { id: 'clear_NORMAL', group: 'difficulty', name: N_('险境突破'), desc: N_('在险境模拟中获胜'), goal: 1, value: (p) => p.clears.NORMAL },
  { id: 'clear_HARD', group: 'difficulty', name: N_('绝境求生'), desc: N_('在绝境模拟中获胜'), goal: 1, value: (p) => p.clears.HARD },
  { id: 'clear_ABYSS', group: 'difficulty', name: N_('终极考验'), desc: N_('在终极模拟中获胜'), goal: 1, value: (p) => p.clears.ABYSS },
  { id: 'hidden_1', group: 'difficulty', name: N_('触及核心'), desc: N_('击破隐秘核心 1 次'), goal: 1, value: (p) => p.hidden },
  { id: 'hidden_10', group: 'difficulty', name: N_('核心猎手'), desc: N_('击破隐秘核心 10 次'), goal: 10, value: (p) => p.hidden },
  { id: 'hidden_abyss', group: 'difficulty', name: N_('深渊之底'), desc: N_('在终极模拟中击破隐秘核心'), goal: 1, value: (p) => p.hiddenAbyss },
  { id: 'coop_10', group: 'alliance', name: N_('同盟战友'), desc: N_('完成 10 场同盟模拟'), goal: 10, value: (p) => p.modes.coop.games },
  { id: 'coop_wins_10', group: 'alliance', name: N_('同盟凯歌'), desc: N_('同盟模拟获胜 10 场'), goal: 10, value: (p) => p.modes.coop.wins },
  { id: 'solo_wins_10', group: 'alliance', name: N_('独当一面'), desc: N_('独立模拟获胜 10 场'), goal: 10, value: (p) => p.modes.solo.wins },
  { id: 'bands_10', group: 'strategy', name: N_('博采众长'), desc: N_('使用过 10 种不同的策略'), goal: 10, value: (p) => p.bandKinds },
  { id: 'bands_25', group: 'strategy', name: N_('运筹帷幄'), desc: N_('使用过 25 种不同的策略'), goal: 25, value: (p) => p.bandKinds },
  { id: 'titles_6', group: 'strategy', name: N_('评语收藏家'), desc: N_('获得全部 6 种评语'), goal: 6, value: (p) => p.titleKinds },
  { id: 'kills_1000', group: 'combat', name: N_('千军辟易'), desc: N_('累计击倒 1,000 名敌人'), goal: 1000, value: (p) => p.sums.kills || 0 },
  { id: 'kills_20000', group: 'combat', name: N_('万夫莫当'), desc: N_('累计击倒 20,000 名敌人'), goal: 20000, value: (p) => p.sums.kills || 0 },
  { id: 'boss_1m', group: 'combat', name: N_('领袖克星'), desc: N_('累计对领袖造成 1,000,000 伤害'), goal: 1_000_000, value: (p) => p.sums.bossDamage || 0 },
  { id: 'perfect_50', group: 'combat', name: N_('完美作战'), desc: N_('累计 50 回合完美作战'), goal: 50, value: (p) => p.sums.perfectRounds || 0 },
  { id: 'merges_200', group: 'combat', name: N_('精英集结'), desc: N_('累计晋升干员 200 次'), goal: 200, value: (p) => p.sums.merges || 0 },
  { id: 'trophy_10', group: 'trophy', name: N_('崭露头角'), desc: N_('累计获得 10 个奖杯（奖杯等级 2）'), goal: 10, value: (p) => p.trophies },
  { id: 'trophy_30', group: 'trophy', name: N_('声名鹊起'), desc: N_('累计获得 30 个奖杯（奖杯等级 3）'), goal: 30, value: (p) => p.trophies },
  { id: 'trophy_60', group: 'trophy', name: N_('威名远扬'), desc: N_('累计获得 60 个奖杯（奖杯等级 4）'), goal: 60, value: (p) => p.trophies },
  { id: 'trophy_100', group: 'trophy', name: N_('卫戍传奇'), desc: N_('累计获得 100 个奖杯（奖杯等级 5）'), goal: 100, value: (p) => p.trophies },
]);

export const ACHIEVEMENT_GROUPS = Object.freeze([
  ['career', N_('模拟经历'), 'hourglass'], ['victory', N_('胜利'), 'crown'], ['difficulty', N_('难度'), 'rook'],
  ['alliance', N_('同盟'), 'users'], ['strategy', N_('策略'), 'book'], ['combat', N_('战斗'), 'sword'], ['trophy', N_('奖杯'), 'crown'],
]);

/** Each achievement with its value, done flag and fraction. */
export function achievementsOf(progress) {
  return ACHIEVEMENTS.map((a) => {
    const v = Math.max(0, Number(a.value(progress)) || 0);
    return { ...a, current: Math.min(v, a.goal), done: v >= a.goal, frac: Math.min(1, v / a.goal) };
  });
}

/** The local progress, read when a component mounts (the stats change only between matches). */
function useProgress() {
  const [p, setP] = useState(() => progressOf(peekStatsRecords()));
  useEffect(() => {
    const again = () => { if (document.visibilityState !== 'hidden') setP(progressOf(peekStatsRecords())); };
    document.addEventListener('visibilitychange', again);
    return () => document.removeEventListener('visibilitychange', again);
  }, []);
  return p;
}

/** The low hills behind the entry card's emblem (original drawing). */
function Land() {
  return html`<svg class="hub-ach__land" viewBox="0 0 320 88" preserveAspectRatio="none" aria-hidden="true" focusable="false">
    <rect width="320" height="88" fill="#d7a35a" />
    <path d="M0 52 C40 40 70 58 110 46 S180 30 220 44 S290 56 320 40 V88 H0z" fill="#b97a34" />
    <path d="M0 66 C50 58 90 74 140 64 S230 54 270 66 S310 72 320 68 V88 H0z" fill="#8a5420" />
  </svg>`;
}

/** The hub's 成就统计 card: the trophy level, the reached count; opens the panel. */
export function AchievementEntry({ onOpen }) {
  const card = useMyCard();
  const p = useProgress();
  const list = achievementsOf(p);
  const done = list.filter((a) => a.done).length;
  return html`<button type="button" class="hub-ach" onClick=${onOpen} aria-haspopup="dialog" title=${t('成就统计：本机的模拟纪录、奖杯与成就')}>
    <span class="hub-ach__scene"><${Land} /><span class="hub-ach__mark"><${Emblem} /></span>
      <span class="hub-ach__rank"><${TrophyBadge} count=${card.trophies ?? p.trophies} /><small><${Icon} name="crown" />${fmt(card.trophies ?? p.trophies)}</small></span>
    </span>
    <span class="hub-ach__label">${t('成就统计')}<span class="hub-ach__lv num">${done}/${list.length}</span></span>
  </button>`;
}

/** One achievement mark: the group icon, the name, the description, a bar while it is not reached. */
function Mark({ a, icon }) {
  return html`<div class=${`ach-mark ach-mark--row${a.done ? ' is-done' : ''}`} title=${t(a.desc)}>
    <span class="ach-mark__frame"><${Icon} name=${icon} />${a.done ? html`<span class="ach-mark__badge"><${Icon} name="check" /></span>` : null}</span>
    <span class="ach-mark__text">
      <b>${t(a.name)}</b><small>${t(a.desc)}</small>
      ${a.done ? html`<span class="ach-mark__got">${t('已达成')}</span>`
        : html`<span class="ach-mark__bar" aria-label=${`${fmt(a.current)} / ${fmt(a.goal)}`}><i style=${`width:${(a.frac * 100).toFixed(1)}%`}></i><em class="num">${fmt(a.current)} / ${fmt(a.goal)}</em></span>`}
    </span>
  </div>`;
}

/** A section bar of the panel. */
function Bar({ title, micro, icon }) {
  return html`<div class="ach-bar"><span class="ach-bar__icon"><${Icon} name=${icon} /></span><span class="ach-bar__title">${title}</span>
    <span class="ach-bar__marks"><i><${Icon} name="rook" /></i><${MicroLabel} class="ach-bar__micro">${micro}<//></span></div>`;
}

/** The 成就统计 panel (local data; Esc / ✕ / the backdrop close it). */
export function AchievementPanel({ me, onClose }) {
  const gd = useGameData();
  const card = useMyCard();
  const p = useProgress();
  const list = useMemo(() => achievementsOf(p), [p]);
  const [picking, setPicking] = useState(false);
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && !picking) onClose(); };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [picking]);
  const done = list.filter((a) => a.done).length;
  const level = trophyLevel(p.trophies);
  const opRec = card.charId && gd.ready ? gd.list('chess').find((c) => c.charId === card.charId) : null;
  const bands = Object.entries(p.agg.bands).sort((a, b) => b[1].games - a[1].games).slice(0, 3);
  const titles = (Array.isArray(gd.config?.titles) ? gd.config.titles : []).map((x) => ({ ...x, count: p.agg.titles[x.id]?.count || 0 }));
  const icons = Object.fromEntries(ACHIEVEMENT_GROUPS.map(([g, , icon]) => [g, icon]));
  return html`<div class="ach" role="presentation" onMouseDown=${(e) => { if (e.target === e.currentTarget) onClose(); }}>
    <div class="ach__box" role="dialog" aria-modal="true" aria-label=${t('成就统计')}>
      <header class="ach__head">
        <span class="ach__logo"><${Icon} name="rook" /><b>STRONGHOLD<br />PROTOCOL</b></span>
        <span class="ach__band"><${Emblem} /><span class="ach__titles"><i>ALLIANCE</i><b>${t('卫戍协议：盟约')}</b></span></span>
      </header>
      <button type="button" class="ach__close" onClick=${onClose} aria-label=${t('关闭')}><${Icon} name="close" /></button>
      <div class="ach__body">
        <div class="ach-top-area">
          <div class="ach-plate">
            <div class=${`ach-card${card.bg ? ' has-nc' : ''}`}>
              <${NameCardLayer} card=${card.bg} />
              <span class="ach-card__ava">${opRec ? html`<${Img} src=${chessAvatarUrl(gd.m, opRec)} alt="" />` : html`<span class="ach-card__glyph">${[...(me?.name || '?')][0]}</span>`}
                <span class="ach-card__lv"><b class="num">${level}</b><small>LV</small></span></span>
              <span class="ach-card__who">
                <span class="ach-card__name">${me?.name || t('博士')}</span>
                <span class="ach-card__id num">${me?.playerId != null ? `DOCTOR #${doctorNo(me.playerId)}` : 'DOCTOR'}</span>
                <button type="button" class="ach-card__nc" onClick=${() => setPicking(true)}><${Icon} name="edit" />${t('名片底图')}</button>
              </span>
              <span class="ach-card__brand">STRONGHOLD<br />PROTOCOL</span>
            </div>
            <div class="ach-counts">
              <span class="ach-counts__badge is-trophy"><${TrophyBadge} count=${p.trophies} /></span>
              <span class="ach-counts__row"><small><${Icon} name="crown" />${t('已获奖杯')}</small><b class="num">${fmt(p.trophies)}</b></span>
              <span class="ach-counts__badge"><${Icon} name="check" /></span>
              <span class="ach-counts__row"><small>${t('已达成成就')}</small><b class="num">${done}<small> / ${list.length}</small></b></span>
            </div>
          </div>
          <div class="ach-modes">
            ${[['solo', t('独立模拟'), 'user'], ['coop', t('同盟模拟'), 'users']].map(([m, name, icon]) => html`<div key=${m} class="ach-modes__row">
              <span class="ach-modes__mode"><${Icon} name=${icon} /><b>${name}</b></span>
              <span class="ach-modes__cell"><b class="num">${fmt(p.modes[m].games)}</b><small>${t('模拟场次')}</small></span>
              <span class="ach-modes__cell"><b class="num">${fmt(p.modes[m].wins)}</b><small>${t('胜利场次')}</small></span>
              <span class="ach-modes__cell"><b class="num">${fmt(p.modes[m].best)}</b><small>${t('最远回合')}</small></span>
            </div>`)}
          </div>
        </div>

        <${Bar} title=${t('成就')} micro="ACHIEVEMENTS" icon="crown" />
        ${ACHIEVEMENT_GROUPS.map(([g, label]) => html`<div key=${g} class="ach-list">
          <p class="ach-sub">${t(label)}</p>
          <div class="ach-marks ach-marks--list">${list.filter((a) => a.group === g).map((a) => html`<${Mark} key=${a.id} a=${a} icon=${icons[g]} />`)}</div>
        </div>`)}

        <${Bar} title=${t('策略纪录')} micro="STRATEGY RECORD" icon="book" />
        ${bands.length ? html`<div class="ach-tops ach-tops--band">${bands.map(([id, b], i) => {
          const rec = gd.band(id);
          return html`<div key=${id} class="ach-top ach-top--band" style=${`animation-delay:${i * 60}ms`}>
            <span class="ach-top__frame"><i class="ach-top__rank">${i + 1}</i><${BandIcon} bandId=${id} size="lg" /></span>
            <span class="ach-top__side"><span class="ach-top__name">${rec?.name || id}</span>
              <span class="ach-top__count"><b class="num">${fmt(b.games)}</b><small>${t('场')}</small></span>
              <small class="t-dim">${t('胜场 {n}', { n: fmt(b.wins) })}</small></span>
          </div>`;
        })}</div>` : html`<p class="ach-empty">${t('还没有纪录')}</p>`}

        <${Bar} title=${t('评语纪录')} micro="COMMENTS" icon="info" />
        ${titles.length ? html`<div class="ach-tops ach-tops--titles">${titles.map((x) => html`<div key=${x.id} class=${`ach-top ach-top--title${x.count ? '' : ' is-none'}`} title=${x.text || ''}>
          <span class="ach-top__frame"><${Img} src=${titleIconUrl(gd.m, x.picId)} fallback=${html`<${Icon} name="crown" />`} /></span>
          <span class="ach-top__name">${x.name}</span><span class="ach-top__count"><b class="num">${fmt(x.count)}</b></span>
        </div>`)}</div>` : html`<p class="ach-empty">${t('还没有纪录')}</p>`}
        <p class="ach-local"><${Icon} name="info" />${t('成就统计只读取本机的统计数据，不会上传；换浏览器或清除数据后会重新开始，可在「统计数据」里导出、导入。')}</p>
      </div>
      <span class="ach__foot">${t('奖杯等级 {lv}', { lv: level })}</span>
    </div>
    ${picking ? html`<${NameCardPicker} current=${card.bg} onPick=${setCardBackground} onClose=${() => setPicking(false)} />` : null}
  </div>`;
}
