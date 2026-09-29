'use strict'
// All cryptography goes through libsodium. We compose its high-level APIs and
// never build primitives ourselves:
//
//   identity    crypto_sign (Ed25519)        your id, signs every record you publish
//   box key     crypto_box (X25519)          receives sealed likes, messages and grants
//   mail        crypto_box_seal              anonymous: hides sender and recipient
//   media       XChaCha20-Poly1305 (AEAD)    one random key per photo
//
// Call `await ready()` once before using anything else in this module.

const sodium = require('libsodium-wrappers')

let s = null
async function ready () {
  await sodium.ready
  s = sodium
}
function lib () {
  if (!s) throw new Error('crypto not initialised: await ready() first')
  return s
}

const toHex = (b) => Buffer.from(b).toString('hex')
const fromHex = (h) => Uint8Array.from(Buffer.from(h, 'hex'))
const toB64 = (b) => Buffer.from(b).toString('base64')
const fromB64 = (t) => Uint8Array.from(Buffer.from(t, 'base64'))

// Identity files store 32-byte secrets (the Ed25519 seed and the X25519
// scalar); public keys are derived from them.
function generateIdentity () {
  const l = lib()
  const seed = l.randombytes_buf(32)
  const sign = l.crypto_sign_seed_keypair(seed)
  const box = l.crypto_box_keypair()
  return {
    version: 1,
    sign: { pub: toHex(sign.publicKey), priv: toHex(seed) },
    box: { pub: toHex(box.publicKey), priv: toHex(box.privateKey) }
  }
}

function signingKey (identity) {
  return lib().crypto_sign_seed_keypair(fromHex(identity.sign.priv)).privateKey
}

// Deterministic JSON so signatures survive re-serialisation.
function canonical (value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort()
      .filter((k) => value[k] !== undefined)
      .map((k) => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}'
  }
  return JSON.stringify(value)
}

function sign (identity, payload) {
  const sig = lib().crypto_sign_detached(canonical(payload), signingKey(identity))
  return { payload, sig: toB64(sig) }
}

// True only if `signed.sig` is a valid signature by `pubHex`.
function verify (signed, pubHex) {
  try {
    if (!/^[0-9a-f]{64}$/.test(pubHex) || !signed || typeof signed.sig !== 'string') return false
    return lib().crypto_sign_verify_detached(fromB64(signed.sig), canonical(signed.payload), fromHex(pubHex))
  } catch {
    return false
  }
}

// Anonymous public-key encryption of a JSON object to one recipient.
function seal (recipientBoxPub, object) {
  return { v: 2, c: toB64(lib().crypto_box_seal(JSON.stringify(object), fromHex(recipientBoxPub))) }
}

// The decrypted object, or null if the box was not addressed to us.
function open (identity, box) {
  try {
    if (!box || box.v !== 2 || typeof box.c !== 'string') return null
    const pt = lib().crypto_box_seal_open(fromB64(box.c), fromHex(identity.box.pub), fromHex(identity.box.priv))
    return JSON.parse(Buffer.from(pt).toString('utf8'))
  } catch {
    return null
  }
}

// ---------------------------------------------------------------- media
//
// File layout: "DTM1" || 24-byte nonce || ciphertext+tag. The owner's id is
// authenticated as associated data, so an object can't be passed off as
// someone else's. Files are named by their SHA-256, which reveals nothing.

const MEDIA_MAGIC = Buffer.from('DTM1')
const mediaAd = (ownerId) => 'datetorrent-media-v1|' + ownerId

function encryptMedia (ownerId, bytes) {
  const l = lib()
  const key = l.crypto_aead_xchacha20poly1305_ietf_keygen()
  const nonce = l.randombytes_buf(l.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES)
  const ct = l.crypto_aead_xchacha20poly1305_ietf_encrypt(bytes, mediaAd(ownerId), null, nonce, key)
  const file = Buffer.concat([MEDIA_MAGIC, Buffer.from(nonce), Buffer.from(ct)])
  return { file, obj: sha256(file), key: toB64(key) }
}

// Returns the plaintext Buffer, or null if the key, owner or bytes don't match.
function decryptMedia (ownerId, file, keyB64) {
  try {
    const l = lib()
    const n = l.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES
    if (!file.subarray(0, 4).equals(MEDIA_MAGIC)) return null
    const nonce = file.subarray(4, 4 + n)
    const pt = l.crypto_aead_xchacha20poly1305_ietf_decrypt(null, file.subarray(4 + n), mediaAd(ownerId), nonce, fromB64(keyB64))
    return Buffer.from(pt)
  } catch {
    return null
  }
}

// ------------------------------------------------------------- recovery
//
// A recovery code is 32 random bytes shown to the user once, in base32. It
// encrypts a backup of their identity that is stored (as ciphertext) in the
// public database, so any replica can restore them. The backup's filename is
// derived from the code, so the code alone is enough to find it.

const B32 = 'abcdefghijklmnopqrstuvwxyz234567'

function newRecoveryCode () {
  const bytes = lib().randombytes_buf(32)
  let bits = ''
  for (const b of bytes) bits += b.toString(2).padStart(8, '0')
  let out = ''
  for (let i = 0; i < bits.length; i += 5) out += B32[parseInt(bits.slice(i, i + 5).padEnd(5, '0'), 2)]
  return out.match(/.{1,4}/g).join('-')
}

function recoveryKey (code) {
  const clean = String(code).toLowerCase().replace(/[^a-z2-7]/g, '')
  if (clean.length !== 52) throw new Error('A recovery code has 52 letters and digits')
  let bits = ''
  for (const ch of clean) bits += B32.indexOf(ch).toString(2).padStart(5, '0')
  const key = Uint8Array.from(bits.slice(0, 256).match(/.{8}/g).map((b) => parseInt(b, 2)))
  return { key, locator: sha256(Buffer.concat([Buffer.from('datetorrent-backup-locator|'), Buffer.from(key)])) }
}

function secretSeal (key, object, ad) {
  const l = lib()
  const nonce = l.randombytes_buf(l.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES)
  const c = l.crypto_aead_xchacha20poly1305_ietf_encrypt(JSON.stringify(object), ad, null, nonce, key)
  return { n: toB64(nonce), c: toB64(c) }
}

function secretOpen (key, box, ad) {
  try {
    const pt = lib().crypto_aead_xchacha20poly1305_ietf_decrypt(null, fromB64(box.c), ad, fromB64(box.n), key)
    return JSON.parse(Buffer.from(pt).toString('utf8'))
  } catch {
    return null
  }
}

function sha256 (data) {
  return require('node:crypto').createHash('sha256').update(data).digest('hex')
}

module.exports = {
  ready, generateIdentity, sign, verify, seal, open, canonical, sha256,
  encryptMedia, decryptMedia, newRecoveryCode, recoveryKey, secretSeal, secretOpen
}
