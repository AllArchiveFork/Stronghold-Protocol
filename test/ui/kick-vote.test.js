// 投票移出 (feedback #12): ui/kickVote.js offers the vote only on a teammate the AI plays because they stayed offline
// (m.public players[].offlineTakeover), in SP_DRAFT / PREP, to a connected human, while no other kick vote is open.

import { test } from "node:test";
import assert from "node:assert/strict";
import { PHASE } from "../../shared/constants.js";
import { kickable } from "../../public/js/ui/kickVote.js";

const p = (playerId, extra = {}) => ({ playerId, isBot: false, alive: true, connected: true, status: "acting", ...extra });
const pub = (extra = {}) => ({ phase: PHASE.PREP, kickVote: null,
  players: [p("me"), p("off", { connected: false, autoplay: true, offlineTakeover: true }), p("away", { autoplay: true }), p("bot", { isBot: true })], ...extra });
const of = (v, id) => v.players.find((x) => x.playerId === id);

test("an offline seat under the AI takeover can be voted out in PREP and SP_DRAFT", () => {
  for (const phase of [PHASE.PREP, PHASE.SP_DRAFT]) { const v = pub({ phase }); assert.equal(kickable(v, "me", of(v, "off")), true); }
});

test("not a connected 暂离 seat, a bot, oneself, other phases, an open vote or an offline proposer", () => {
  const v = pub();
  assert.equal(kickable(v, "me", of(v, "away")), false);
  assert.equal(kickable(v, "me", of(v, "bot")), false);
  assert.equal(kickable(v, "off", of(v, "off")), false);
  for (const phase of [PHASE.INFO_CHECK, PHASE.BAND_DRAFT, PHASE.COMBAT]) { const w = pub({ phase }); assert.equal(kickable(w, "me", of(w, "off")), false); }
  const w = pub({ kickVote: { id: 1 } });
  assert.equal(kickable(w, "me", of(w, "off")), false);
  const x = pub(); of(x, "me").connected = false;
  assert.equal(kickable(x, "me", of(x, "off")), false);
  const y = pub(); of(y, "off").alive = false;
  assert.equal(kickable(y, "me", of(y, "off")), false);
});
