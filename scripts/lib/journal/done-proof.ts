/**
 * The proof a `done` carries. Closing an item says the outcome was checked, so the writer wants either what was checked
 * (`--verify "<command or url>"`) or an admission that nothing was (`--unverified`, which keeps the item flagged on the
 * front page). Pure: the CLI hands in the two flags as given.
 */
export interface DoneProofFlags { verify: { given: boolean; value: string | null }; unverified: boolean }

export type DoneProof = { proof: { verified: string } | { unverified: true }; errors: [] } | { proof: null; errors: string[] };

const VERIFY_MAX = 300;
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/;

export function parseDoneProof(f: DoneProofFlags): DoneProof {
    if (f.verify.given && f.unverified) return { proof: null, errors: ['Give --verify or --unverified, not both: a done is either checked or flagged as not checked.'] };
    if (f.unverified) return { proof: { unverified: true }, errors: [] };
    if (!f.verify.given) return { proof: null, errors: ['done needs --verify "<the command or url that shows it worked>" (the commit pushed, the comment visible, the ticket moved), or --unverified if you did not check. An unverified item stays flagged on the front page.'] };
    const value = (f.verify.value ?? '').replace(/\s+/g, ' ').trim();
    if (!value) return { proof: null, errors: ['--verify needs a value: the command or url that shows it worked. Use --unverified if you did not check.'] };
    if (CONTROL.test(value)) return { proof: null, errors: ['--verify has a control character in it.'] };
    if (value.length > VERIFY_MAX) return { proof: null, errors: [`--verify is over ${VERIFY_MAX} characters: name the one command or url.`] };
    return { proof: { verified: value }, errors: [] };
}
