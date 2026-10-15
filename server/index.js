// server/index.js — process boot; HTTP routes, static delivery and WebSocket wiring live in server/http/.
// Worker pools are process-owned loans to matches. Startup and shutdown keep diagnostics separate from readiness.
// Process-entry boot checks a pending update package before listening (server/update.js).
// The default dual-stack bind may fall back to IPv4; explicit hosts remain literal.
// Art under public/assets and public/fonts is served with content-hash URLs once the background index is ready
// (http/assetIndex.js, http/assetViews.js; SP_ASSET_INDEX=0: off); GET /healthz?traffic=1 adds the traffic counters
// (http/traffic.js) for a local client.
// Plugins (DESIGN §32, docs/PLUGINS.md): the registry, the vanilla content hash, the visual and content sets, the room
// policy, the match hosts of rooms with gameplay plugins and the plugin studio are wired in startServer below
// (server/plugins/, server/match/host/, server/studio/); SP_CSP=off drops the site-wide Content-Security-Policy.

import http from 'node:http';
import path from 'node:path';
import { getData, loadData } from './data.js';
import { ROOT, listenAddress, bindCandidates, serveDirs, makeLogger, parseTrustProxy, assetIndexOptionsFrom } from './http/config.js';
import { WS_MAX_PAYLOAD, createSessionStack, attachWebSocket } from './http/websocket.js';
import { siteCsp } from './http/csp.js';
import { DATA_SHIM_JS, createStaticHandler } from './http/static.js';
import { createPluginRegistry } from './plugins/registry.js';
import { computeVanillaContent } from './plugins/identity.js';
import { createVisualSets } from './plugins/visualSet.js';
import { createContentSets } from './plugins/contentSets.js';
import { createPluginPolicy } from './plugins/policy.js';
import { createRoomSets } from './plugins/roomSets.js';
import { createMatchHosts } from './match/host/index.js';
import { createTrustedRuntime } from './plugins/trustedRuntime.js';
import { trustedHostAllowed } from './plugins/trusted.js';
import { createStudio } from './studio/index.js';
import { MIME, COMPRESSIBLE, acceptsGzip, pickEncoding, parseRange } from './http/files.js';
import { BUILD_INPUTS, computeBuildTag, buildTag, resetBuildTag } from './http/buildTag.js';
import { createRequestHandler } from './http/routes.js';
import { createTrafficCounter } from './http/traffic.js';
import { createAssetIndex } from './http/assetIndex.js';
import { createManifestViews } from './http/assetViews.js';
import { answerClientError } from './http/common.js';
import { lanUrls, displayHost, isProcessEntry, runMain } from './http/boot.js';
import { CombatWorkerPool } from './match/combat/pool.js';
import { createHealthMetrics, serverLoadState, publicLoadDetails } from './healthMetrics.js';
import { resolveWsCompression } from './wsCompression.js';
import { createOnlineLimit } from './onlineLimit.js';
import { createOwnerFile } from './ownerFile.js';
import { parseSnapshotHz } from './match/fields.js';

export {
  ROOT, WS_MAX_PAYLOAD, DATA_SHIM_JS, MIME, COMPRESSIBLE, BUILD_INPUTS, computeBuildTag, buildTag, resetBuildTag,
  acceptsGzip, pickEncoding, parseRange, createStaticHandler, lanUrls, parseTrustProxy,
};

/** Zero retains the synchronous backend; malformed pool configuration fails before listening. */
export function parseCombatWorkers(value) {
  if (value == null || value === '') return 0;
  if (typeof value !== 'number' && typeof value !== 'string') throw new RangeError('SP_COMBAT_WORKERS must be an integer from 0 to 32');
  const s = String(value).trim();
  if (!/^(0|[1-9]\d*)$/.test(s) || Number(s) > 32) throw new RangeError('SP_COMBAT_WORKERS must be an integer from 0 to 32');
  return Number(s);
}

export function parseTrialWorkers(value) {
  if (value == null || value === '') return 1;
  if (typeof value !== 'number' && typeof value !== 'string') throw new RangeError('SP_TRIAL_WORKERS must be an integer from 0 to 2');
  const s = String(value).trim();
  if (!/^[0-2]$/.test(s)) throw new RangeError('SP_TRIAL_WORKERS must be an integer from 0 to 2');
  return Number(s);
}

/**
 * Build and start the HTTP + WebSocket server.
 * @param {{
 *   port?: number, host?: string, quiet?: boolean, log?: object,
 *   publicDir?: string, dataDir?: string, sharedDir?: string, packsDir?: string, pluginsDir?: string,
 *   MatchClass?: Function, seedFn?: () => number,
 *   lobbyGraceMs?: number, reconnectWindowMs?: number, heartbeatMs?: number, helloTimeoutMs?: number,
 *   ratePerSec?: number, rateBurst?: number, maxConnections?: number, maxRooms?: number,
 *   maxConnectionsPerAddr?: number, maxRoomsPerAddr?: number, maxMatchesPerAddr?: number, resyncMinGapMs?: number,
 *   heavyPerSec?: number, heavyBurst?: number, trustProxy?: 'auto' | boolean, soloReconnectWindowMs?: number,
 *   assetIndex?: boolean | { cacheFile?: string | null, delayMs?: number }, studio?: boolean,
 *   matchHost?: object,
 * }} [opts]
 *   client: 'build' or 'source' — which page `/` is (default SP_CLIENT; http/static.js clientModeFromEnv);
 *   assetIndex: the content-hash index (default on; false or SP_ASSET_INDEX=0: off — config.js assetIndexOptionsFrom);
 *   studio: the plugin studio at /studio/ (default on for this machine and the local network — SP_STUDIO=local|off;
 *   false: none);
 *   matchHost: options of the match hosts (server/match/host/index.js — watchdogMs, matchOptions …; tests)
 * @returns {Promise<{ port: number, host: string, url: string, server: http.Server, wss: import('ws').WebSocketServer,
 *                     lobby: import('./lobby.js').Lobby, network: import('./net.js').Network,
 *                     registry: import('./net.js').SessionRegistry, packs: ReturnType<typeof createPluginRegistry>,
 *                     content: import('./plugins/identity.js').VanillaContent, visual: ReturnType<typeof createVisualSets>,
 *                     contents: ReturnType<typeof createContentSets>, hosts: ReturnType<typeof createMatchHosts>,
 *                     traffic: ReturnType<typeof createTrafficCounter>, assetIndex: ReturnType<typeof createAssetIndex> | null,
 *                     views: ReturnType<typeof createManifestViews> | null, studio: ReturnType<typeof createStudio> | null,
 *                     close: () => Promise<void> }>}
 */
export async function startServer(opts = {}) {
  const { port, host } = listenAddress(opts);
  const log = opts.log || makeLogger(!!opts.quiet);
  const wsCompression = resolveWsCompression(opts.wsCompression ?? process.env.SP_WS_COMPRESSION ?? 'off');
  const snapshotHz = parseSnapshotHz(opts.snapshotHz ?? process.env.SP_SNAPSHOT_HZ);
  const combatWorkers = parseCombatWorkers(opts.combatWorkers ?? process.env.SP_COMBAT_WORKERS);
  const trialSetting = opts.trialWorkers ?? process.env.SP_TRIAL_WORKERS;
  const requestedTrials = parseTrialWorkers(trialSetting);
  const trialWorkers = combatWorkers && (trialSetting != null && trialSetting !== '' || String(process.env.SP_COMBAT || '').toLowerCase() === 'server')
    ? requestedTrials : 0;
  const { publicDir, dataDir, sharedDir, packsDir, pluginsDir } = serveDirs(opts);
  const simDir = path.join(ROOT, 'server', 'sim');

  // The process-wide singleton serves the default data dir; a custom dir (tests) gets its own copy.
  const data = opts.dataDir ? loadData(dataDir, { log }) : getData({ dir: dataDir, log });
  const combatPool = combatWorkers ? new CombatWorkerPool({ size: combatWorkers, data, log }) : null;
  let trialPool = null, trialStartupFailed = false, healthMetrics = null;
  const closePools = () => Promise.all([trialPool?.close(), combatPool?.close()]);
  if (combatPool) {
    try { await combatPool.start(); } catch (e) { await closePools(); throw e; }
    log.info(`[combat] fixed worker pool ready (${combatWorkers} workers; server streaming only)`);
  }
  if (trialWorkers) {
    try {
      trialPool = new CombatWorkerPool({ role: 'trial', size: trialWorkers, data, log });
      await trialPool.start();
      log.info(`[trial] dedicated rehearsal pool ready (${trialWorkers} workers)`);
    } catch (e) {
      try { await trialPool?.close(); } catch (closeError) { await combatPool?.close(); throw closeError; }
      trialPool = null;
      trialStartupFailed = true;
      log.warn?.(`[trial] worker startup failed; rehearsal stays inline: ${e.message}`);
    }
  }
  const scriptMode = process.env.SP_PLUGIN_SCRIPTS;
  let registry, lobby, network, packs, serveStatic, browserBuild, assetIndex = null, views = null;
  let content = null, visual = null, contents = null, hosts = null, studio = null, trustedRuntime = null;
  const startedAt = Date.now();
  // The online cap and the lobby's room / AI caps (server/onlineLimit.js): a JSON file re-read while the server runs; none = no cap.
  const onlineLimit = createOnlineLimit({ file: opts.onlineLimitFile ?? process.env.SP_ONLINE_LIMIT_FILE ?? null, log });
  // The owner (服主) mark (server/ownerFile.js): the owner key's hash and reserved names, re-read while the server runs; none = off.
  const ownerFile = createOwnerFile({ file: opts.ownerFile ?? process.env.SP_OWNER_FILE ?? null, log });
  await ownerFile.refresh(); // the first read before any hello: reserved names hold from the start (never rejects)
  try {
    // the vanilla content hash `cs` (DESIGN §32): the bytes of the served sim, shared code and game data, read once now —
    // like the data the matches use and the build tag below
    content = computeVanillaContent({ simDir, sharedDir, dataDir, shim: DATA_SHIM_JS, log });
    log.info(`[content] vanilla ${content.cs.slice(0, 16)} (${Object.keys(content.simFiles).length} code files, ${Object.keys(content.data).length} data files)`);
    // language packs and plugins (docs/PACKS.md, docs/PLUGINS.md): scanned now — the start log names them — and again
    // whenever their folders change
    packs = createPluginRegistry({ publicDir, dataDir, packsDir, pluginsDir }, { log, scriptHost: host, scriptMode });
    packs.refresh(true);
    // the content hashes of the art (built in the background once listening) and the manifests served with them
    const indexOptions = assetIndexOptionsFrom(opts, publicDir);
    assetIndex = indexOptions ? createAssetIndex({ publicDir, log, ...indexOptions }) : null;
    views = assetIndex ? createManifestViews({ dataDir, index: assetIndex, log }) : null;
    // the visual sets of the cosmetic plugins (DESIGN §32 P1a): what a room's host switches on, served at /vs/ and /p/
    visual = createVisualSets({ registry: packs, log });
    // the server owner's policy (plugins/config.json), the content sets of the gameplay plugins (served at /cs/<cs16>/…),
    // what a room's plugins make of both, and the match hosts a room with gameplay plugins plays in (DESIGN §32.6)
    const policy = createPluginPolicy({ pluginsDir, log });
    contents = createContentSets({ registry: packs, vanillaData: data, log, maxSets: () => policy.get().maxSets });
    const roomSets = createRoomSets({ registry: packs, visual, contents, policy });
    // a child process per content set; SP_MATCH_HOST=worker asks for a worker thread instead (match/host/index.js header:
    // an out-of-memory abort in a worker thread ends the whole server)
    const transport = String(process.env.SP_MATCH_HOST || '').trim().toLowerCase() === 'worker' ? 'worker' : 'process';
    hosts = createMatchHosts({ contents, log, options: { transport, maxWorkers: Math.max(1, policy.get().maxSets), ...(opts.matchHost || {}) } });
    ({ registry, lobby, network } = createSessionStack({ ...opts, snapshotHz }, {
      data, log, combatPool, trialPool, onlineLimit, ownerFile, content, plugins: roomSets, hosts,
      getLoadState: () => serverLoadState(healthMetrics?.snapshot?.()),
      getLoadDetails: () => publicLoadDetails(healthMetrics?.snapshot?.()),
    }));
    serveStatic = createStaticHandler({ publicDir, dataDir, sharedDir, simDir, packsDir, pluginsDir, packs, content, log, metrics: opts.phaseMetrics,
      assetIndex, views, visual, contents, ...(opts.client ? { client: opts.client } : {}) });
    // the plugin studio (DESIGN §32.9): its page and API for this machine and the local network; it watches plugins/ only
    // once it is used (hot reload), and rooms whose host is the author or alone follow a plugin's changes by themselves
    studio = opts.studio === false ? null : createStudio({ publicDir, pluginsDir, dataDir, registry: packs, lobby, sessions: registry, log, fetch: opts.fetch });
    trustedRuntime = await createTrustedRuntime({ registry: packs, log });
    lobby.trustedRuntime = trustedRuntime;
    browserBuild = computeBuildTag(ROOT, publicDir);
  } catch (e) {
    network?.close();
    lobby?.shutdown('boot-failed');
    try { hosts?.close(); } catch { /* boot already failed */ }
    studio?.close();
    await trustedRuntime?.close();
    onlineLimit.close();
    ownerFile.close();
    assetIndex?.close();
    await closePools();
    throw e;
  }
  const traffic = createTrafficCounter();
  const health = { startedAt, network, registry, lobby, content, browserBuild, combatPool, trialPool, trialStartupFailed,
    getHealthMetrics: () => healthMetrics, traffic, assetIndex, views, trusted: trustedRuntime?.health };
  const server = http.createServer(createRequestHandler({ serveStatic, csp: process.env.SP_CSP === 'off' ? null : siteCsp(publicDir), health, log,
    trustProxy: network.opts.trustProxy, studio, trustedRuntime }));
  server.on('clientError', answerClientError);
  const wss = attachWebSocket(server, { network, log, wsCompression, traffic });

  // The address actually bound. The default may fall back to IPv4; the returned host and url follow that.
  let boundHost;
  try {
    // A host with IPv6 switched off refuses '::'. Fall back to IPv4 rather than not booting. Only the default is
    // retried: an explicit HOST is literal (server/http/config.js bindCandidates).
    let bound = null;
    let lastError = null;
    const candidates = bindCandidates(host);
    for (let i = 0; i < candidates.length; i++) {
      const candidate = candidates[i];
      try {
        await new Promise((resolve, reject) => {
          const onError = (e) => { server.off('listening', onListening); reject(e); };
          const onListening = () => { server.off('error', onError); resolve(); };
          server.once('error', onError);
          server.once('listening', onListening);
          server.listen(port, candidate);
        });
        bound = candidate;
        break;
      } catch (e) {
        lastError = e;
        const retry = ['EAFNOSUPPORT', 'EADDRNOTAVAIL', 'EINVAL'].includes(e.code) && i < candidates.length - 1;
        if (!retry) break;
        log.warn(`[boot] cannot bind ${candidate} (${e.code}) — falling back to IPv4 only`);
      }
    }
    if (bound === null) throw lastError;
    boundHost = bound;
    // Check the kernel's address too: aliases/DNS and bind fallback cannot weaken the owner gate.
    const actual = server.address();
    const scriptHost = actual && typeof actual === 'object' ? actual.address : '';
    packs.setScriptHost(scriptHost);
    if (!trustedHostAllowed(scriptHost, scriptMode)) {
      lobby.trustedRuntime = null;
      await trustedRuntime?.close();
    }
  } catch (e) {
    network.close();
    lobby.shutdown('boot-failed');
    onlineLimit.close();
    ownerFile.close();
    assetIndex?.close();
    try { hosts?.close(); } catch { /* boot already failed */ }
    studio?.close();
    await trustedRuntime?.close();
    await closePools();
    throw e;
  }
  server.on('error', e => log.error('[http] server error', e));
  assetIndex?.start();
  try {
    healthMetrics = (opts.healthMetricsFactory ?? createHealthMetrics)(opts.phaseMetrics ? { log, phases: opts.phaseMetrics } : { log });
    healthMetrics.start();
  } catch (e) {
    try { healthMetrics?.dispose(); } catch { /* diagnostic only */ }
    healthMetrics = null;
    try { log.warn?.(`[health] performance metrics unavailable: ${e.message}`); } catch { /* diagnostic only */ }
  }
  const addr = server.address();
  const actualPort = typeof addr === 'object' && addr ? addr.port : port;
  const url = `http://${displayHost(boundHost)}:${actualPort}`;
  let closing = null;
  async function close() {
    if (closing) return closing;
    closing = (async () => {
      try { healthMetrics?.dispose(); } catch (e) {
        try { log.warn?.('[health] performance disposal failed', e); } catch { /* diagnostic only */ }
      }
      try { lobby.shutdown('shutdown'); } catch (e) { log.error('[shutdown] lobby', e); }
      try { hosts.close(); } catch (e) { log.error('[shutdown] match hosts', e); }
      network.close();
      onlineLimit.close();
      ownerFile.close();
      assetIndex?.close();
      studio?.close();
      await trustedRuntime?.close();
      await closePools();
      await new Promise(resolve => {
        server.close(() => resolve());
        server.closeIdleConnections?.();
        setTimeout(() => { server.closeAllConnections?.(); }, 500).unref();
      });
      try { wss.close(); } catch { /* ignore */ }
    })();
    return closing;
  }
  return { port: actualPort, host: boundHost, url, server, wss, lobby, network, registry, packs, content, visual, contents, hosts, combatPool, trialPool,
    healthMetrics, traffic, assetIndex, views, studio, close };
}

if (isProcessEntry(import.meta.url)) runMain(startServer);
