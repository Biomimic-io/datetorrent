'use strict'
// Validation for everything that enters the database from a peer. Anything
// that fails here is silently dropped during sync, so a hostile peer can only
// waste bandwidth, never inject data.

const GENDERS = ['woman', 'man', 'nonbinary', 'other']
const MAX_FILE_BYTES = 12 * 1024 // profiles and mail
const MAX_VAULT_BYTES = 128 * 1024
const MAX_MEDIA_BYTES = 2 * 1024 * 1024
const MAX_MEDIA = 40 // encrypted objects a profile may own
const MAX_PUBLIC_PHOTOS = 6
const MAX_GRANT_PHOTOS = 30
const ID_RE = /^[0-9a-f]{64}$/
const KEY_RE = /^[A-Za-z0-9+/]{43}=$/ // 32-byte key, base64
// Only DHT-addressed GitTorrent URLs are auto-discovered from profiles. Anything
// else (ext::, file paths, ssh) could make git run commands or touch local files.
const GITTORRENT_URL_RE = /^gittorrent:\/\/[0-9a-f]{40}\/[A-Za-z0-9._-]{1,64}$/
const CLOCK_SKEW_MS = 24 * 60 * 60 * 1000

const str = (v, max) => typeof v === 'string' && v.length <= max
const strList = (v, maxItems, maxLen) => Array.isArray(v) && v.length <= maxItems && v.every((s) => str(s, maxLen))
const int = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi
const photoRefs = (v, max) => Array.isArray(v) && v.length <= max &&
  v.every((x) => x && ID_RE.test(x.obj) && KEY_RE.test(x.key) && Object.keys(x).length === 2)

function validProfilePayload (p) {
  if (!p || typeof p !== 'object') return false
  if (p.v !== 1 || !ID_RE.test(p.id) || !ID_RE.test(p.box)) return false
  if (!int(p.updated, 0, Date.now() + CLOCK_SKEW_MS)) return false
  if (p.deleted === true) return true
  return str(p.name, 40) && p.name.trim().length > 0 &&
    int(p.age, 18, 120) &&
    GENDERS.includes(p.gender) &&
    strList(p.seeking, GENDERS.length, 12) && p.seeking.every((g) => GENDERS.includes(g)) &&
    int(p.ageMin, 18, 120) && int(p.ageMax, 18, 120) && p.ageMin <= p.ageMax &&
    str(p.region, 60) &&
    str(p.bio, 500) &&
    strList(p.interests, 20, 30) &&
    // Every encrypted object this person stores, so replicas can refuse media
    // nobody vouches for. Public photos also publish their decryption key.
    Array.isArray(p.media) && p.media.length <= MAX_MEDIA && p.media.every((m) => ID_RE.test(m)) &&
    new Set(p.media).size === p.media.length &&
    photoRefs(p.photos, MAX_PUBLIC_PHOTOS) && p.photos.every((x) => p.media.includes(x.obj)) &&
    (p.gittorrent === undefined || (str(p.gittorrent, 200) && GITTORRENT_URL_RE.test(p.gittorrent)))
}

function validEnvelopePayload (p) {
  if (!p || typeof p !== 'object') return false
  if (!ID_RE.test(p.from) || !ID_RE.test(p.to) || p.from === p.to) return false
  if (!int(p.at, 0, Date.now() + CLOCK_SKEW_MS)) return false
  // Per-sender sequence number: orders a sender's events even if their clock jumps.
  if (!int(p.n, 1, Number.MAX_SAFE_INTEGER)) return false
  if (p.type === 'like' || p.type === 'unlike') return true
  if (p.type === 'grant') return photoRefs(p.photos, MAX_GRANT_PHOTOS) && p.photos.length > 0
  return p.type === 'msg' && str(p.text, 2000) && p.text.trim().length > 0
}

// Normalise user input from the CLI / UI into a profile payload (unsigned).
function profileFromInput (input, identity, previous = {}) {
  const list = (v) => (Array.isArray(v) ? v : String(v || '').split(','))
    .map((s) => String(s).trim().toLowerCase()).filter(Boolean)
  const merged = { ...previous, ...input }
  const payload = {
    v: 1,
    id: identity.sign.pub,
    box: identity.box.pub,
    name: String(merged.name || '').trim(),
    age: parseInt(merged.age, 10),
    gender: String(merged.gender || '').toLowerCase(),
    seeking: list(merged.seeking),
    ageMin: parseInt(merged.ageMin ?? 18, 10),
    ageMax: parseInt(merged.ageMax ?? 99, 10),
    region: String(merged.region || '').trim(),
    bio: String(merged.bio || '').trim(),
    interests: list(merged.interests).slice(0, 20),
    media: merged.media || [],
    photos: merged.photos || [],
    gittorrent: merged.gittorrent || undefined,
    updated: Math.max(Date.now(), (previous.updated || 0) + 1)
  }
  if (!validProfilePayload(payload)) {
    const problems = []
    if (!payload.name) problems.push('name is required (max 40 chars)')
    if (!int(payload.age, 18, 120)) problems.push('age must be 18 or over')
    if (!GENDERS.includes(payload.gender)) problems.push(`gender must be one of ${GENDERS.join(', ')}`)
    if (!payload.seeking.length || !payload.seeking.every((g) => GENDERS.includes(g))) problems.push(`seeking must list some of ${GENDERS.join(', ')}`)
    if (!(payload.ageMin <= payload.ageMax) || payload.ageMin < 18) problems.push('age range must be 18+ and min <= max')
    if (payload.bio.length > 500) problems.push('bio is limited to 500 chars')
    if (payload.region.length > 60) problems.push('region is limited to 60 chars')
    throw new Error('Invalid profile: ' + (problems.join('; ') || 'check field lengths'))
  }
  return payload
}

module.exports = {
  GENDERS, MAX_FILE_BYTES, MAX_VAULT_BYTES, MAX_MEDIA_BYTES, MAX_MEDIA, MAX_PUBLIC_PHOTOS, MAX_GRANT_PHOTOS,
  ID_RE, KEY_RE, GITTORRENT_URL_RE,
  validProfilePayload, validEnvelopePayload, profileFromInput
}
