/**
 * The one place the per-node identity cutoff DATE is written down.
 *
 * It lives in `@shared` rather than in the policy module because three parties have to agree on it
 * and only one of them can import `src/core`: the policy itself
 * (`src/core/agents/node-identity-policy.ts`, which builds the instant and the refusal sentences
 * from it), the routes that apply it, and the **Settings row** in the renderer — and the renderer
 * must never import the service core.
 *
 * A date the user reads in Settings that disagrees with the date the server enforces is the worst
 * possible version of this feature, so there is exactly one string and everything else derives.
 *
 * The value is the owner's rule — *the second minor release or 60 days after the shipping release,
 * whichever is later* — resolved to a concrete day. Resolved, not computed: a rule that has to be
 * re-derived from a release calendar is a rule that quietly never fires. See docs/node-identity.md.
 */
export const NODE_IDENTITY_STRICT_DATE = '2026-10-13'
