// server/persist/index.js — the server's side of the checkpoints (docs/DEPLOY.md「断点续玩」): off unless SP_REDIS_URL
// names a Valkey / Redis compatible store (or a test passes `persistStore`). startServer calls createPersistence after
// the lobby exists and before it listens: the saved lobby and its matches come back first (a store that is not
// answering yet is waited for, at most persister.js RESTORE_WAIT_MS), then the periodic writes start; close() writes a
// last time before the lobby shuts its rooms (quietly).
//
// Game nodes use server/persist/node.js instead (their matches' checkpoints), see server/cluster/game-runtime.js.

import { storeConfig, createCheckpointStore } from './store.js';
import { LobbyPersister, SAVE_MS } from './persister.js';

export { storeConfig, createCheckpointStore } from './store.js';

/**
 * @param {{ opts: object, registry: import('../net.js').SessionRegistry, lobby: import('../lobby.js').Lobby, log: object }} args
 *   opts.persistStore (tests): a ready CheckpointStore; opts.redisUrl / redisPrefix / redisPasswordFile override the
 *   environment; opts.persistSaveMs the write interval; opts.persistRestoreWaitMs (tests) the startup read's budget
 * @returns {Promise<{ persister: LobbyPersister, store: any, restored: object, snapshot: () => object, shutdown: () => Promise<boolean>,
 *   close: () => Promise<void> } | null>}
 */
export async function createPersistence({ opts = {}, registry, lobby, log }) {
  let store = opts.persistStore || null;
  const owned = !store;
  if (!store) {
    const config = storeConfig({ url: opts.redisUrl, prefix: opts.redisPrefix, passwordFile: opts.redisPasswordFile });
    if (!config) return null;
    store = createCheckpointStore(config, { log });
  }
  const saveMs = Number(opts.persistSaveMs ?? process.env.SP_PERSIST_SAVE_MS) || SAVE_MS;
  const persister = new LobbyPersister({ store, registry, lobby, log, saveMs, restoreWaitMs: opts.persistRestoreWaitMs });
  let restored;
  try { restored = await persister.restore(); }
  catch (e) { restored = { ok: false, reason: e.message }; log.warn?.(`[persist] restore failed (${e.message}); starting fresh`); }
  persister.start();
  log.info?.(`[persist] checkpoints on (every ${persister.saveMs / 1000} s)`);
  return {
    persister, store, restored,
    snapshot: () => persister.snapshot(),
    shutdown: () => persister.shutdown(),
    close: async () => { await persister.close(); if (owned) await store.close(); },
  };
}
