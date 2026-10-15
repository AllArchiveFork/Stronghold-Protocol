// Process-owned assembly for a game node: the transport borrows these pools,
// this owner starts/closes them. Ordinary server/index.js remains opt-out.
import { CombatWorkerPool } from '../match/combat/pool.js';
import { getData } from '../data.js';
import { createHealthMetrics, serverLoadState, publicLoadDetails } from '../healthMetrics.js';
import { parseCombatWorkers, parseTrialWorkers } from '../index.js';
import { startGameNode } from './game-node.js';
import { createRpcAuthenticator, createRpcClient } from './rpc.js';
import { sendEndReceipt, sendMemberRemoved } from './receipts.js';
import { storeConfig, createCheckpointStore } from '../persist/store.js';
import { NodeCheckpoints } from '../persist/node.js';

const noopLog = { info() {}, warn() {}, error() {}, debug() {} };
export async function startGameRuntime({ combatWorkers = 8, trialWorkers = 2, coordinatorUrl,
  data, log = noopLog, onEnd, onRemoved, persistStore = null, persistSaveMs, ...options } = {}) {
  const combatCount = parseCombatWorkers(combatWorkers), trialCount = combatCount ? parseTrialWorkers(trialWorkers) : 0;
  const gameData = data ?? getData({ log });
  let combatPool, trialPool, node, events, closing, checkpoints = null;
  const metrics = createHealthMetrics({ log });
  // match checkpoints (SP_REDIS_URL; server/persist/node.js): off unless a store is configured
  const store = persistStore || createCheckpointStore(storeConfig(), { log });
  if (coordinatorUrl) events = createRpcClient({ url: coordinatorUrl,
    authority: createRpcAuthenticator({ key: options.key, scope: options.nodeId }) });
  if (!events && typeof onEnd !== 'function') throw new TypeError('game runtime requires an end-receipt target');
  try {
    if (combatCount) {
      combatPool = new CombatWorkerPool({ size: combatCount, data: gameData, log });
      await combatPool.start();
    }
    if (trialCount) {
      trialPool = new CombatWorkerPool({ role: 'trial', size: trialCount, data: gameData, log });
      await trialPool.start();
    }
    node = await startGameNode({ ...options, data: gameData, log, combatPool, trialPool, streamMarkers: true,
      getLoadState: () => serverLoadState(metrics.snapshot()),
      getLoadDetails: () => publicLoadDetails(metrics.snapshot()),
      onEnd: receipt => {
        if (onEnd) return onEnd(receipt);
        return sendEndReceipt({ client: events, nodeGeneration: options.generation, receipt });
      },
      // the AFK rule: the coordinator leaves the removed player's room seat (receipts.js member.removed)
      onRemoved: removal => {
        if (typeof onRemoved === 'function') return onRemoved(removal);
        return events ? sendMemberRemoved({ client: events, nodeGeneration: options.generation, removal }) : undefined;
      },
      restoreSource: store ? (checkpointId, assignmentId) => checkpoints ? checkpoints.load(checkpointId, assignmentId) : null : null,
      getCheckpointStats: store ? () => checkpoints?.snapshot() ?? null : null });
    if (store) checkpoints = new NodeCheckpoints({ store, gameHost: node.gameHost, nodeId: options.nodeId, log,
      saveMs: persistSaveMs ?? (Number(process.env.SP_PERSIST_SAVE_MS) || undefined) }).start();
    metrics.start();
  } catch (e) {
    await checkpoints?.shutdown(); if (!persistStore) await store?.close();
    metrics.dispose(); events?.close();
    await node?.close(); await trialPool?.close(); await combatPool?.close();
    throw e;
  }
  const close = () => {
    if (closing) return closing;
    closing = (async () => {
      // the last checkpoints before the actors go (server/persist/node.js)
      await checkpoints?.shutdown();
      await node.close(); metrics.dispose(); events?.close();
      if (!persistStore) await store?.close();
      await trialPool?.close(); await combatPool?.close();
    })();
    return closing;
  };
  return { ...node, combatPool, trialPool, metrics, checkpoints, close };
}
