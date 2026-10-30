// Ed25519 PUBLIC key (SPKI PEM) used to verify project-allowance tokens offline. This is the public
// half of the backend's PROJECT_ALLOWANCE_PRIVATE_KEY (held only in the server env). It is NOT a
// secret — it can only verify, not sign. If you rotate the server key, update this too.
//
// It is a DIFFERENT key from ENTITLEMENT_PUBLIC_KEY on purpose (spec §6): shipped clients accept any
// entitlement-key signature that carries their deviceId and a live `exp`, checking neither `typ`
// nor `tier`, so an allowance token signed with the entitlement key would read as Pro everywhere.
//
// TODO(O1): the owner pastes the production SPKI PEM here before merge. Until then it is empty, so
// every allowance token verifies to null, and the merge-guard test in project-allowance-token.test.ts
// ("parses as an Ed25519 public key and differs from ENTITLEMENT_PUBLIC_KEY") stays red.
export const PROJECT_ALLOWANCE_PUBLIC_KEY: string = ''
