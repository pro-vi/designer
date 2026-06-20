// The design preview iframe is a load-bearing invariant: it must serve from
// claudeusercontent.com. How it's addressed has drifted — the legacy form was
// `claudeusercontent.com/...?t=<signed-token>`; the 2026-06 redesign (issue #61)
// moved it to a per-project `<uuid>.claudeusercontent.com/_bootstrap...` subdomain
// with no token. Assert the HOST (real drift = the preview leaving that domain),
// not a substring — a substring match would wave through a suffix-attached host
// (`claudeusercontent.com.evil.test`) or a query/path mention
// (`evil.test/?u=claudeusercontent.com`), defeating the drift anchor this backs.
export function isPreviewIframeSrc(src: string): boolean {
  let host: string;
  try {
    host = new URL(src).hostname;
  } catch {
    return false;
  }
  return host === 'claudeusercontent.com' || host.endsWith('.claudeusercontent.com');
}

// Which addressing scheme the (already host-validated) preview src uses. Reported
// in the health anchor's detail so drift between the legacy signed-token form and
// the current per-project bootstrap subdomain stays legible.
export function previewIframeVariant(src: string): 'signed-token' | 'bootstrap-subdomain' | 'other' {
  if (/[?&]t=/.test(src)) return 'signed-token';
  if (/\/_bootstrap/.test(src)) return 'bootstrap-subdomain';
  return 'other';
}

// True when `html` is the unauthenticated ~1.1KB loader shell the bootstrap
// iframe serves to the parent origin (not the rendered design). A node fetch of a
// bootstrap-subdomain src always returns this shell; the real DOM only exists in
// the cross-origin OOPIF (see oopif-reader.ts). The shell's stable signature is
// its postMessage init handshake ('omelette-preview-init') — class/markup hashes
// drift, that string does not. Used to assert the OOPIF read returned rendered
// content, not the loader, and to defend callers against saving a shell as the
// captured artifact. Empty / non-shell HTML → false (don't misread "no sample").
//
// Size-bounded (review below-gate): a rendered design that legitimately
// DOCUMENTS the preview protocol could contain the marker string, so require the
// document also be loader-sized. The real shell is ~1.1KB; any rendered design is
// far larger, so the marker + a sub-4KB body is an unambiguous shell signal.
const BOOTSTRAP_SHELL_MAX_BYTES = 4000;
export function isBootstrapShellHtml(html: string): boolean {
  return typeof html === 'string' && html.length < BOOTSTRAP_SHELL_MAX_BYTES && html.includes('omelette-preview-init');
}
