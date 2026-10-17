import { html, Icon } from './components.js';
import { t } from '../../../shared/i18n.js';

// The edge host's own pages (deploy/stardust/feedback, deploy/stardust/monitoring), beside the feedback group: the
// public feedback board and the server status dashboard. Same origin and the same password gate as the game; they open
// in a new tab so the lobby and its connection stay where they are (the owner's request of 2026-10-16).
export const FEEDBACK_BOARD = '/feedback/';
export const STATUS_BOARD = '/monitor/';

export function SiteBoards() {
  return html`<nav class="hub-boards" aria-label=${t('反馈与服务器状态')}>
    <a class="btn btn--secondary btn--sm hub-board" href=${FEEDBACK_BOARD} target="_blank" rel="noopener"
      title=${t('反馈板：提交 Bug 与玩法建议，查看回复和处理状态（新标签页打开）')}><${Icon} name="edit" class="btn__icon" /><span class="btn__label">${t('反馈板')}</span></a>
    <a class="btn btn--secondary btn--sm hub-board hub-board--status" href=${STATUS_BOARD} target="_blank" rel="noopener"
      title=${t('服务器状态：在线人数、对局数与服务健康（新标签页打开）')}><${Icon} name="server" class="btn__icon" /><span class="btn__label">${t('服务器状态')}</span></a>
  </nav>`;
}
