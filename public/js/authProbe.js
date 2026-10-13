// Sign-in expiry behind a host's gate (deploy/stardust/auth, the owner's report of 2026-10-13): once the gate's sign-in
// expires it refuses the WebSocket upgrade with 401, which a page cannot read from a failed WebSocket — the client only
// kept reconnecting, and the longer it stayed away the likelier its seat was lost. After AUTH_PROBE_AFTER failed
// attempts in a row, each further attempt GETs /client-build once (gated like the socket; a host without a gate answers
// 200): a 401 asks the player to sign in again. Signing in reloads this tab, which the gate turns into its sign-in page
// and back; the tab keeps its token (sessionStorage), so its seat resumes. Asked at most once until the next welcome.

/** Failed connection attempts in a row before the first probe. */
export const AUTH_PROBE_AFTER = 3;

/**
 * @param {{ fetch?: typeof fetch, ask: () => Promise<boolean>, reload?: () => void, after?: number }} deps
 *   ask: the sign-in prompt (true: sign in now)
 * @returns {{ onStatus: (snap: { status: string, attempt: number }) => Promise<void>, onWelcome: () => void }}
 */
export function createAuthProbe({ fetch: fetchFn = (...a) => globalThis.fetch(...a), ask, reload = () => globalThis.location.reload(),
  after = AUTH_PROBE_AFTER }) {
  let probed = 0, asked = false;
  return {
    async onStatus(snap) {
      if (asked || snap?.status !== 'reconnecting' || !(snap.attempt >= after) || snap.attempt === probed) return;
      probed = snap.attempt;
      let res;
      try { res = await fetchFn('/client-build', { cache: 'no-store', credentials: 'same-origin' }); } catch { return; }
      try { void res.body?.cancel?.().catch(() => {}); } catch { /* the status is all this needs */ }
      if (res.status !== 401 || asked) return;
      asked = true;
      if (await ask()) reload();
    },
    onWelcome() { probed = 0; asked = false; },
  };
}
