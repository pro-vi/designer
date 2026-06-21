// Opener for claude.ai/design's "Design Files" panel, shared by BOTH the live
// listFilesDetailed scrape (designer-controller) and the session.fileListScrape
// health anchor (ui-anchors) — one source so the probe exercises the exact path
// production runs. They diverged once and the probe went green while production
// silently no-op'd (PR #77 Codex P2); a shared constant prevents a repeat.
//
// React attaches handlers via root delegation, so the trigger's element.onclick
// is null — we click the label (the event bubbles to React's delegated handler)
// rather than walking up for a non-null .onclick (which never fires).
//
// IDEMPOTENT (open-only): a blind label.click() TOGGLES an already-open panel
// CLOSED. listFilesDetailed leaves the panel open and iterate() calls listFiles()
// both before AND after a generation, so a toggle would make the second scrape
// read the bare page and corrupt newFiles/removedFiles (PR #77 Codex P2). So we
// only click when we can tell the panel is closed:
//   1. trigger exposes aria-expanded → obey it (open iff 'false', no-op if 'true')
//   2. otherwise → click only when NO file-list row is visible at all (a
//      collapsed / standalone project). ANY visible filename row is treated as
//      "already showing" — including a single-file project's one row — so we
//      never toggle an open panel shut (PR #77 Codex P2: a 1-row open panel was
//      slipping past a >=2 threshold and being closed, making iterate() report
//      the lone file as removed). This matches the pre-fix behavior for projects
//      whose files are already visible (no completeness regression) while still
//      opening a genuinely-collapsed list.
// Returns true if the label was found (clicked or already-open), false otherwise.
export const OPEN_FILES_PANEL_EXPR = `(() => {
  const spans = Array.from(document.querySelectorAll('span'));
  const label = spans.find((s) => s.children.length === 0 && (s.textContent || '').trim() === 'Design Files');
  if (!label) return false;
  let t = label;
  for (let i = 0; i < 4 && t; i++) {
    const ex = t.getAttribute && t.getAttribute('aria-expanded');
    if (ex === 'true') return true;
    if (ex === 'false') { label.click(); return true; }
    t = t.parentElement;
  }
  const fileRe = /^[A-Za-z0-9 _.()\\-]+\\.(html|css|js|jsx|tsx|ts|md|json|svg)$/i;
  const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = w.nextNode())) {
    const tx = (n.textContent || '').trim();
    if (fileRe.test(tx) && tx.length < 80) return true; // a file row is showing — don't toggle it shut
  }
  label.click();
  return true;
})()`;
