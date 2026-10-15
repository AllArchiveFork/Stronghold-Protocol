// In-match notice line (fork 2026-10-16, after xinhai-ai/Stronghold-Protocol e48507e / bcf7edb): the lobby's banner —
// the server's maintenance switch (presence.state still reaches a running match) or the newest announcement's `banner`
// line (ui/announcements.js announcementBanner) — also shows while the match route is on screen, under the top bar,
// and, first of all, a match the server restored from the end of this round's prep (m.public replayRound,
// server/match/snapshot.js) says so for that prep: the round's battle is fought again,
// taking no input except its close button. Presentation only: main.js (MatchNoticeHost) owns the optional announcement
// file — re-read every MATCH_NOTICE_REFRESH_MS while the page is visible — so the match screen never waits for it.
// Closing hides that text for this page; another text shows again.
import { html, Icon } from './components.js';
import { useState } from '../../vendor/hooks.module.js';
import { useDocClass } from './device.js';
import { announcementBanner } from './announcements.js';
import { t } from '../../../shared/i18n.js';
import { PHASE } from '../../../shared/constants.js';

export const MATCH_NOTICE_REFRESH_MS = 120_000;

/** Whether m.public is the prep of a round the server restored from its prep's end (its battle is fought again). */
export function replayingRound(pub) {
  return !!pub && Number.isInteger(pub.replayRound) && pub.replayRound > 0 && pub.phase === PHASE.PREP && pub.round === pub.replayRound;
}

/**
 * The line to show: a replayed round first, then maintenance (the same words as the lobby), else the announcement's
 * banner; or null.
 */
export function matchNoticeText(presence, announcements, { replay = false } = {}) {
  if (replay) return t('服务器重启后已恢复对局：本回合回到休整期，战斗将重新进行');
  if (presence?.maintenance === true) return t('服务器即将维护，暂停开启新的模拟');
  return announcementBanner(announcements);
}

let closedText = null; // this page

/** @param {{ text: string | null }} props */
export function MatchNotice({ text }) {
  const [closed, setClosed] = useState(closedText);
  const show = !!text && text !== closed;
  useDocClass('sp-notice', show);
  if (!show) return null;
  const close = () => { closedText = text; setClosed(text); };
  return html`<div class="match-notice" role="status">
    <${Icon} name="info" />
    <span class="match-notice__text">${text}</span>
    <button type="button" class="match-notice__close" aria-label=${t('关闭')} onClick=${close}><${Icon} name="close" /></button>
  </div>`;
}
