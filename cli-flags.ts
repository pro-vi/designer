// Flag decoding decisions that are worth testing on their own.
//
// `parseFlags` in cli.ts is deliberately generic: it never knows which flags are
// boolean, so `--yes` in `files-delete --yes name.html` swallows the filename as
// its value, and `--yes=false` arrives as the STRING "false". Both shapes reach
// the one flag that authorizes an irreversible delete, so the decision gets a
// name, a home, and a test instead of living inline in the switch.

export interface ConsentDecision {
  /** True only when the user actually authorized the destructive action. */
  consent: boolean;
  /** A positional the parser swallowed as the flag's value; put it back. */
  recoveredPositional: string | null;
}

/**
 * Decode `--yes` into consent, recovering a filename the parser ate.
 *
 * Boolean literals are decoded FIRST: treating any string as consent meant
 * `--yes=false index.html` both authorized the delete AND produced the filename
 * "false index.html" (review #134 F2). An explicit false must never authorize.
 */
export function decodeConsent(value: string | boolean | undefined): ConsentDecision {
  if (value === true) return { consent: true, recoveredPositional: null };
  if (typeof value !== 'string') return { consent: false, recoveredPositional: null };

  const v = value.trim();
  // `--yes=` yields an empty string, which expresses no consent at all. Falling
  // through to the "it must be a filename" branch would have authorized a delete
  // from it — the same shape as the bug this function exists to fix.
  if (v === '') return { consent: false, recoveredPositional: null };
  if (/^(false|0|no|off)$/i.test(v)) return { consent: false, recoveredPositional: null };
  if (/^(true|1|yes|on)$/i.test(v)) return { consent: true, recoveredPositional: null };
  // Not a boolean literal, so it is the positional that followed the bare flag.
  // Return the TRIMMED value: the raw one leaks the parser's spacing into the
  // filename.
  return { consent: true, recoveredPositional: v };
}
