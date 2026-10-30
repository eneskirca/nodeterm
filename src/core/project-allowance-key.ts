// Ed25519 PUBLIC key (SPKI PEM) used to verify project-allowance tokens offline. This is the public
// half of the backend's PROJECT_ALLOWANCE_PRIVATE_KEY (held only in the server env). It is NOT a
// secret — it can only verify, not sign. If you rotate the server key, update this too.
//
// It is a DIFFERENT key from ENTITLEMENT_PUBLIC_KEY on purpose (spec §6): shipped clients accept any
// entitlement-key signature that carries their deviceId and a live `exp`, checking neither `typ`
// nor `tier`, so an allowance token signed with the entitlement key would read as Pro everywhere.
//
// TODO(O1): the owner pastes the production SPKI PEM here (docs/project-limit.md, O1). Until then
// it is empty: every allowance token verifies to null and core never switches the limit on (a
// keyless build stays unlimited, like one from before the limit), so each release made before O1 is
// one the limit will never reach. The flip (frozen-deadline) release is refused while it is empty
// (scripts/check-project-limit-deadline.mjs); project-allowance-token.test.ts accepts only '' or a
// real Ed25519 public-key PEM distinct from ENTITLEMENT_PUBLIC_KEY.
export const PROJECT_ALLOWANCE_PUBLIC_KEY: string = ''
