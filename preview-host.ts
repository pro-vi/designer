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
