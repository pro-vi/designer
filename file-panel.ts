// Opener for claude.ai/design's "Design Files" panel, shared by BOTH the live
// listFilesDetailed scrape (designer-controller) and the session.fileListScrape
// health anchor (ui-anchors) — one source so the probe exercises the exact path
// production runs. They diverged once and the probe went green while production
// silently no-op'd (PR #77 Codex P2); a shared constant prevents a repeat.
//
// Open-state is decided ONLY from the trigger's aria-expanded — the one reliable
// signal. Two tempting alternatives are dead ends Codex walked us through (PR #77):
//   - a blind label.click() TOGGLES an already-open panel shut, and iterate()
//     calls listFiles() before+after a generation, so the second scrape reads the
//     bare page and corrupts newFiles/removedFiles;
//   - counting filename-like body text to infer "already open" can't tell a real
//     panel row from a filename mentioned in a chat turn (index.html), so it
//     skips opening and scrapes incidental text.
// So: if the trigger exposes aria-expanded, obey it (open iff 'false'). If it
// does NOT, leave the panel as-is — never a blind toggle, never a body-text
// guess; the scrape then reads whatever is already visible (the long-standing
// behavior). React attaches handlers via root delegation, so element.onclick is
// null on the trigger — we click the label (the event bubbles to the delegated
// handler) rather than walking up for a non-null .onclick (which never fires).
//
// Returns true when the "Design Files" label is present (opened or already-open
// or left-as-is), false when it isn't found.
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
  return true;
})()`;
