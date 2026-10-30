import { describe, it, expect } from 'vitest'
import crypto from 'node:crypto'
import { verifyAllowanceToken } from './project-allowance-token'
import { PROJECT_ALLOWANCE_PUBLIC_KEY } from './project-allowance-key'
import { ENTITLEMENT_PUBLIC_KEY } from './entitlement-key'
import { machineHashOf } from './machine-id'

// Interop vector: a THROWAWAY Ed25519 pair, and one token minted by nodeterm-server's REAL signer
// (`createAllowanceSigner` in src/lib/project-allowance-token.ts, commit 31efe09) via `npx tsx -e`.
// Only the public half was kept; the private half was never written down. If the server's wire
// format drifts (key order, signed bytes, padding), this is the test that goes red.
const SERVER_TEST_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAUAfhrO24p425RoZib+zQeTo9vfDbHijmPY5/qKBWS9Q=
-----END PUBLIC KEY-----
`
const SERVER_TOKEN =
  'eyJ0eXAiOiJwcm9qZWN0LWFsbG93YW5jZSIsImRldmljZUlkIjoiM2YwYzZhNTItOWQ3ZS00YjhhLWExYzQtNWUyZjdkOWIwYzE4IiwibWFjaGluZSI6ImRlMTY4MTkyYzlhNWZhNDEwZjgxZmQwMzA4NmFmZDUwNTM1NDgzYWVkNTc3ODIxMDZjMTdkMmE5YjIwZjFmMGYiLCJhbGxvd2FuY2UiOjcsImVwb2NoIjozLCJpYXQiOjE3OTMzNjI4ODl9' +
  '.PHXlrBVGe9Itc4fffJMqZc6vWZk-M3mh34POPm0Y-JgmyQMK_M6EnNSptPklBqtvIQDkwRfz2U8SvAYNSob7BA'
const SERVER_DEVICE = '3f0c6a52-9d7e-4b8a-a1c4-5e2f7d9b0c18'
const SERVER_RAW_MACHINE = 'C0FFEE00-1234-4ABC-9DEF-0123456789AB'

// Locally signed tokens use their own throwaway pair, generated per run.
const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519')
const PUB = publicKey.export({ type: 'spki', format: 'pem' }).toString()

const DEVICE = 'device-1'
const MACHINE = machineHashOf('0123456789abcdef0123456789abcdef')
const EXPECT = { deviceId: DEVICE, machine: MACHINE }

/** Sign like the server: base64url(text), then a signature over that base64url TEXT (not the JSON). */
function signText(text: string, key: crypto.KeyObject = privateKey): string {
  const p = Buffer.from(text).toString('base64url')
  return `${p}.${crypto.sign(null, Buffer.from(p), key).toString('base64url')}`
}

const signRaw = (payload: unknown, key?: crypto.KeyObject): string => signText(JSON.stringify(payload), key)

function mint(over: Record<string, unknown> = {}, key: crypto.KeyObject = privateKey): string {
  return signRaw(
    {
      typ: 'project-allowance',
      deviceId: DEVICE,
      machine: MACHINE,
      allowance: 12,
      epoch: 2,
      iat: Math.floor(Date.now() / 1000),
      ...over
    },
    key
  )
}

describe('verifyAllowanceToken', () => {
  it('verifies a token minted by the server signer', () => {
    expect(
      verifyAllowanceToken(
        SERVER_TOKEN,
        { deviceId: SERVER_DEVICE, machine: machineHashOf(SERVER_RAW_MACHINE), epoch: 3 },
        SERVER_TEST_PUBLIC_KEY
      )
    ).toEqual({ allowance: 7, epoch: 3 })
  })

  it('accepts a valid token and returns only { allowance, epoch }', () => {
    expect(verifyAllowanceToken(mint(), EXPECT, PUB)).toEqual({ allowance: 12, epoch: 2 })
  })

  it('checks the epoch only when one is expected', () => {
    expect(verifyAllowanceToken(mint(), { ...EXPECT, epoch: 2 }, PUB)).toEqual({ allowance: 12, epoch: 2 })
    expect(verifyAllowanceToken(mint(), { ...EXPECT, epoch: 3 }, PUB)).toBeNull()
  })

  it('accepts allowance 0 (a non-negative integer)', () => {
    expect(verifyAllowanceToken(mint({ allowance: 0 }), EXPECT, PUB)).toEqual({ allowance: 0, epoch: 2 })
  })

  it('refuses a token signed by another key', () => {
    expect(verifyAllowanceToken(mint(), EXPECT, SERVER_TEST_PUBLIC_KEY)).toBeNull()
    const other = crypto.generateKeyPairSync('ed25519').privateKey
    expect(verifyAllowanceToken(mint({}, other), EXPECT, PUB)).toBeNull()
  })

  it.each([
    ['wrong typ', { typ: 'entitlement' }],
    ['no typ', { typ: undefined }],
    ['wrong deviceId', { deviceId: 'device-2' }],
    ['wrong machine', { machine: machineHashOf('another-machine') }],
    ['allowance -1', { allowance: -1 }],
    ['allowance 2.5', { allowance: 2.5 }],
    ['allowance as a string', { allowance: '12' }],
    ['no allowance', { allowance: undefined }],
    ['epoch not an integer', { epoch: 1.5 }],
    ['no epoch', { epoch: undefined }]
  ])('refuses a signed token with %s', (_label, over) => {
    expect(verifyAllowanceToken(mint(over), EXPECT, PUB)).toBeNull()
  })

  it('refuses an entitlement-shaped token signed with the same key', () => {
    // Everything an allowance needs, minus the kind gate: proves `typ` is checked, not inferred.
    const entitlement = signRaw({
      deviceId: DEVICE,
      tier: 'pro',
      licenseId: 'lic_test',
      machine: MACHINE,
      allowance: 12,
      epoch: 2,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600
    })
    expect(verifyAllowanceToken(entitlement, EXPECT, PUB)).toBeNull()
  })

  it('refuses a tampered payload', () => {
    const [p, s] = mint().split('.')
    const forged = Buffer.from(
      JSON.stringify({ ...JSON.parse(Buffer.from(p, 'base64url').toString('utf-8')), allowance: 50 })
    ).toString('base64url')
    expect(verifyAllowanceToken(`${forged}.${s}`, EXPECT, PUB)).toBeNull()
  })

  it.each([
    ['undefined', undefined],
    ['empty', ''],
    ['no dot', 'abc'],
    ['empty payload segment', '.abc'],
    ['empty signature', `${mint().split('.')[0]}.`],
    ['a signed non-object payload', signRaw(42)],
    ['a signed null payload', signRaw(null)],
    ['a signed non-JSON payload', signText('not json')]
  ])('returns null (never throws) for %s', (_label, token) => {
    expect(verifyAllowanceToken(token, EXPECT, PUB)).toBeNull()
  })

  it('returns null for an unusable public key', () => {
    expect(verifyAllowanceToken(mint(), EXPECT, '')).toBeNull()
    expect(verifyAllowanceToken(mint(), EXPECT, 'not a pem')).toBeNull()
    const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey
    expect(verifyAllowanceToken(mint(), EXPECT, rsa.export({ type: 'spki', format: 'pem' }).toString())).toBeNull()
  })

  it('with the default key, returns null and never throws', () => {
    // Until O1 the shipped key is empty, so nothing verifies; after O1 a token from THIS test pair
    // must still be refused by the production key.
    expect(() => verifyAllowanceToken(mint(), EXPECT)).not.toThrow()
    expect(verifyAllowanceToken(mint(), EXPECT)).toBeNull()
  })
})

describe('PROJECT_ALLOWANCE_PUBLIC_KEY', () => {
  // MERGE GUARD: red until owner step O1 pastes the production SPKI PEM into project-allowance-key.ts.
  it('parses as an Ed25519 public key and differs from ENTITLEMENT_PUBLIC_KEY', () => {
    const key = crypto.createPublicKey(PROJECT_ALLOWANCE_PUBLIC_KEY)
    expect(key.type).toBe('public')
    expect(key.asymmetricKeyType).toBe('ed25519')
    const entitlement = crypto.createPublicKey(ENTITLEMENT_PUBLIC_KEY)
    expect(key.export({ type: 'spki', format: 'der' }).equals(entitlement.export({ type: 'spki', format: 'der' }))).toBe(false)
  })
})
