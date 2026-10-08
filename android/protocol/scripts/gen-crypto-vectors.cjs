// Regenerate src/test/resources/crypto-vectors.json from the DESKTOP's own crypto:
// tweetnacl (the exact library src/main/remote/e2ee.ts uses) + node:crypto HKDF.
//   node android/protocol/scripts/gen-crypto-vectors.cjs   (from the repo root, after npm ci)
// Deterministic: every input comes from a seeded SHA-256 counter, so a rerun is byte-identical.
const path = require('path')
const crypto = require('crypto')
const repo = path.resolve(__dirname, '../../..')
const nacl = require(path.join(repo, 'node_modules/tweetnacl'))

let counter = 0
function det(n) {
  const out = Buffer.alloc(n)
  let off = 0
  while (off < n) {
    const h = crypto.createHash('sha256').update(`nodeterm-android-vectors-${counter++}`).digest()
    h.copy(out, off, 0, Math.min(32, n - off))
    off += 32
  }
  return new Uint8Array(out)
}
const b64 = (u) => Buffer.from(u).toString('base64')

const keypairs = []
for (let i = 0; i < 5; i++) {
  const sk = det(32)
  const kp = nacl.box.keyPair.fromSecretKey(sk)
  keypairs.push({ secretKey: b64(sk), publicKey: b64(kp.publicKey) })
}
const before = []
for (let i = 0; i < 4; i++) {
  const a = nacl.box.keyPair.fromSecretKey(det(32))
  const b = nacl.box.keyPair.fromSecretKey(det(32))
  const shared = nacl.box.before(b.publicKey, a.secretKey)
  const sas = (() => {
    const h = nacl.hash(shared)
    const n = ((h[0] << 24) | (h[1] << 16) | (h[2] << 8) | h[3]) >>> 0
    const code = (n % 1_000_000).toString().padStart(6, '0')
    return `${code.slice(0, 3)} ${code.slice(3)}`
  })()
  before.push({ aSecret: b64(a.secretKey), bPublic: b64(b.publicKey), shared: b64(shared), sas })
}
const secretbox = []
for (const len of [0, 1, 15, 16, 17, 31, 32, 33, 63, 64, 65, 127, 128, 129, 200, 1000, 4099]) {
  const key = det(32)
  const nonce = det(24)
  const msg = det(len)
  secretbox.push({ key: b64(key), nonce: b64(nonce), msg: b64(msg), box: b64(nacl.secretbox(msg, nonce, key)) })
}
const hkdf = []
for (let i = 0; i < 3; i++) {
  const base = det(32)
  const hostNonce = det(16)
  const clientNonce = det(16)
  const salt = Buffer.concat([Buffer.from(hostNonce), Buffer.from(clientNonce)])
  const out = crypto.hkdfSync('sha256', base, salt, Buffer.from('nodeterm-relay-session-v2'), 32)
  hkdf.push({ base: b64(base), hostNonce: b64(hostNonce), clientNonce: b64(clientNonce), sessionKey: b64(new Uint8Array(out)) })
}
const hostIds = keypairs.map((k) => ({
  publicKey: k.publicKey,
  hostId: crypto.createHash('sha256').update(Buffer.from(k.publicKey, 'base64')).digest('base64url').slice(0, 22)
}))
const out = { generatedBy: 'android/protocol/scripts/gen-crypto-vectors.cjs', tweetnacl: require(path.join(repo, 'node_modules/tweetnacl/package.json')).version, keypairs, before, secretbox, hkdf, hostIds }
require('fs').writeFileSync(path.join(__dirname, '../src/test/resources/crypto-vectors.json'), JSON.stringify(out, null, 2) + '\n')
console.log('wrote', secretbox.length, 'secretbox vectors')
