// Shared resolution of the DESIGNER_CDP opt-out.
//
// DESIGNER_CDP has THREE states (see CLAUDE.md): unset or '9222' = CDP on,
// '' = OFF (the agent-browser session-managed flow). The opt-out is enforced at
// the GATES (controller attach, the turn-RPC canary, ensureCdpUp), not in the
// port constants — `browser.ts` resolves the port with `??` (honors '') while
// `cdp-trace.ts`/`cdp-ensure.ts` use `|| '9222'` (do NOT honor ''), by design.
//
// This is the single definition of "is CDP work allowed", so the load-bearing
// gate can't drift across its call sites (it was inlined in designer-controller
// 4× and, inverted, in ui-anchors). Pure, no I/O — reads the env at call time so
// a test or runtime toggle is honored.
export function isCdpEnabled(): boolean {
  return (process.env.DESIGNER_CDP ?? '9222') !== '';
}
