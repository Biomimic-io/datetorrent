'use strict'
// The "torrent database": a plain git repository replicated peer-to-peer.
//
//   datetorrent-db/
//     profiles/<id>.json      signed public profile (id = ed25519 public key, hex)
//     vault/<id>.json         signed, sealed-to-self private catalog: photo keys, grants, blocks
//     media/<sha256>.bin      encrypted photos, one random key each
//     mail/<sha256>.json      sealed boxes: likes, unlikes, messages, photo grants
//     backup/<locator>.json   identity encrypted under a recovery code
//
// Every writer only touches files named after their own key or content-addressed
// files, so replicas merge without conflicts. Sync never runs `git merge`: it
// reads each peer's tree, verifies every file and copies across only what
// checks out. Possessing a replica never grants access to private content;
// only receiving keys does.

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync, execFile } = require('node:child_process')
const c = require('./crypto')
const schema = require('./schema')
const { preparePhoto } = require('./image')

const DB_NAME = 'datetorrent-db'
const BRANCH = 'master' // gittorrentd announces refs/heads/master as the repo head
const DIRS = ['profiles', 'vault', 'media', 'mail', 'backup']
const PROFILE_RE = /^profiles\/([0-9a-f]{64})\.json$/
const VAULT_RE = /^vault\/([0-9a-f]{64})\.json$/
const MEDIA_RE = /^media\/([0-9a-f]{64})\.bin$/
const MAIL_RE = /^mail\/([0-9a-f]{64})\.json$/
const BACKUP_RE = /^backup\/([0-9a-f]{64})\.json$/
// Commits are public forever; never stamp them with the user's real git identity.
const ANON_GIT = ['-c', 'user.name=datetorrent', '-c', 'user.email=peer@datetorrent.invalid']
const SAFE_GIT = ['-c', 'protocol.ext.allow=never']
const BACKUP_AD = (locator) => 'datetorrent-backup-v1|' + locator

const DB_README = `# DateTorrent database

This repository is a replica of the DateTorrent peer-to-peer dating database.
It is served over GitTorrent and merged by the \`datetorrent\` app, which
verifies every file's signature before accepting it.

Public profiles are readable by anyone and permanent. Photos, private
catalogs, likes, messages and backups are encrypted; holding this repository
does not give access to them.
`

function defaultHome () {
  return process.env.DATETORRENT_HOME || path.join(os.homedir(), '.datetorrent')
}

const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null } }

class Store {
  constructor (home = defaultHome()) {
    this.home = path.resolve(home)
    this.dbDir = path.join(this.home, DB_NAME)
    this.identityPath = path.join(this.home, 'identity.json')
    this.statePath = path.join(this.home, 'state.json')
    this._mailCache = new Map() // filename -> verified inner payload, or null if not ours
  }

  // ---------------------------------------------------------------- setup

  get initialized () {
    return fs.existsSync(this.identityPath) && fs.existsSync(path.join(this.dbDir, '.git'))
  }

  initDb () {
    fs.mkdirSync(this.home, { recursive: true, mode: 0o700 })
    if (!fs.existsSync(path.join(this.dbDir, '.git'))) {
      fs.mkdirSync(this.dbDir, { recursive: true })
      this.git(['init', '-q', '-b', BRANCH])
      fs.writeFileSync(path.join(this.dbDir, 'README.md'), DB_README)
      this.git(['add', 'README.md'])
      this.git([...ANON_GIT, 'commit', '-q', '-m', 'Initialise DateTorrent database'])
    }
    for (const d of DIRS) fs.mkdirSync(path.join(this.dbDir, d), { recursive: true })
    // Lets gittorrentd (and `git daemon`) serve this repo.
    fs.writeFileSync(path.join(this.dbDir, '.git', 'git-daemon-export-ok'), '')
  }

  init ({ from } = {}) {
    this.initDb()
    if (!fs.existsSync(this.identityPath)) {
      fs.writeFileSync(this.identityPath, JSON.stringify(c.generateIdentity(), null, 2), { mode: 0o600 })
    }
    if (from) this.addPeer(from)
    return this
  }

  requireInit () {
    if (!this.initialized) throw new Error(`No DateTorrent identity in ${this.home}. Run \`datetorrent init\` first.`)
  }

  get identity () {
    if (!this._identity) this._identity = JSON.parse(fs.readFileSync(this.identityPath, 'utf8'))
    return this._identity
  }

  get myId () { return this.identity.sign.pub }

  git (args, opts = {}) {
    return execFileSync('git', [...SAFE_GIT, ...args], {
      cwd: this.dbDir,
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      ...opts
    })
  }

  readState () { return readJson(this.statePath) || { passed: [] } }

  writeState (state) {
    fs.writeFileSync(this.statePath, JSON.stringify(state, null, 2), { mode: 0o600 })
  }

  commit (message) {
    this.git(['add', '-A', ...DIRS])
    if (!this.git(['status', '--porcelain']).trim()) return false
    this.git([...ANON_GIT, 'commit', '-q', '-m', message])
    return true
  }

  file (...parts) { return path.join(this.dbDir, ...parts) }

  // ------------------------------------------------------------- profiles

  // Parse and verify a profile file's contents. Returns the payload or null.
  checkProfile (raw, expectedId) {
    if (Buffer.byteLength(raw) > schema.MAX_FILE_BYTES) return null
    let signed
    try { signed = JSON.parse(raw) } catch { return null }
    const p = signed && signed.payload
    if (!p || p.id !== expectedId) return null
    if (!schema.validProfilePayload(p) || !c.verify(signed, p.id)) return null
    return p
  }

  profile (id) {
    try { return this.checkProfile(fs.readFileSync(this.file('profiles', id + '.json'), 'utf8'), id) } catch { return null }
  }

  profiles ({ includeDeleted = false } = {}) {
    return fs.readdirSync(this.file('profiles'))
      .map((f) => PROFILE_RE.exec('profiles/' + f))
      .filter(Boolean)
      .map((m) => this.profile(m[1]))
      .filter((p) => p && (includeDeleted || !p.deleted))
  }

  me () { return this.profile(this.myId) }

  // Signs and writes our profile without committing.
  publishProfile (fields) {
    const previous = this.me() || {}
    const payload = schema.profileFromInput(fields, this.identity, previous.deleted ? {} : previous)
    fs.writeFileSync(this.file('profiles', payload.id + '.json'), JSON.stringify(c.sign(this.identity, payload), null, 2) + '\n')
    return payload
  }

  // Public entry point for user-edited fields. Photos are managed separately.
  saveProfile (input) {
    const { media, photos, id, box, ...fields } = input // eslint-disable-line no-unused-vars
    const existed = !!this.me()
    const payload = this.publishProfile(fields)
    this.commit(existed ? 'Update profile' : 'Add profile')
    return payload
  }

  // Publishes a tombstone and drops our encrypted photos from this replica.
  // Earlier versions remain in git history everywhere.
  deleteProfile () {
    const payload = { v: 1, id: this.myId, box: this.identity.box.pub, deleted: true, updated: Date.now() }
    fs.writeFileSync(this.file('profiles', this.myId + '.json'), JSON.stringify(c.sign(this.identity, payload), null, 2) + '\n')
    for (const p of this.catalog().photos) fs.rmSync(this.file('media', p.obj + '.bin'), { force: true })
    this.commit('Remove profile')
  }

  // Resolve a (possibly abbreviated) id to a full profile id.
  resolveId (prefix) {
    const p = String(prefix || '').toLowerCase()
    if (!/^[0-9a-f]{4,64}$/.test(p)) throw new Error(`"${prefix}" is not a profile id (use at least 4 hex characters)`)
    const hits = this.profiles().filter((x) => x.id.startsWith(p))
    if (hits.length === 0) throw new Error(`No profile starts with ${p}`)
    if (hits.length > 1) throw new Error(`${p} is ambiguous (${hits.length} profiles); use more characters`)
    return hits[0].id
  }

  // ---------------------------------------------------------------- vault
  //
  // Our private catalog lives in the database too, sealed to our own box key,
  // so a restored identity gets its photo keys and grants back from any peer.

  checkVault (raw, expectedId) {
    if (Buffer.byteLength(raw) > schema.MAX_VAULT_BYTES) return null
    let signed
    try { signed = JSON.parse(raw) } catch { return null }
    const p = signed && signed.payload
    const ok = p && p.v === 1 && p.id === expectedId && Number.isInteger(p.updated) &&
      p.box && p.box.v === 2 && typeof p.box.c === 'string' && c.verify(signed, p.id)
    return ok ? p : null
  }

  catalog () {
    if (this._catalog) return this._catalog
    const empty = { photos: [], grants: {}, blocked: [], updated: 0 }
    let raw = null
    try { raw = fs.readFileSync(this.file('vault', this.myId + '.json'), 'utf8') } catch {}
    const p = raw && this.checkVault(raw, this.myId)
    const opened = p && c.open(this.identity, p.box)
    this._catalog = { ...empty, ...(opened || {}), updated: p ? p.updated : 0 }
    return this._catalog
  }

  writeCatalog (catalog) {
    const updated = Math.max(Date.now(), (catalog.updated || 0) + 1)
    const { updated: _u, ...contents } = catalog // eslint-disable-line no-unused-vars
    const payload = { v: 1, id: this.myId, updated, box: c.seal(this.identity.box.pub, contents) }
    fs.writeFileSync(this.file('vault', this.myId + '.json'), JSON.stringify(c.sign(this.identity, payload)) + '\n')
    this._catalog = { ...contents, updated }
  }

  // --------------------------------------------------------------- photos

  addPhoto (bytes, { isPublic = false, caption = '' } = {}) {
    this.requireInit()
    const me = this.me()
    if (!me) throw new Error('Create your profile first.')
    if (me.media.length >= schema.MAX_MEDIA) throw new Error(`You can store up to ${schema.MAX_MEDIA} photos.`)
    if (isPublic && me.photos.length >= schema.MAX_PUBLIC_PHOTOS) throw new Error(`Up to ${schema.MAX_PUBLIC_PHOTOS} photos can be public.`)
    const { file, obj, key } = c.encryptMedia(this.myId, preparePhoto(bytes))
    fs.writeFileSync(this.file('media', obj + '.bin'), file)
    const cat = this.catalog()
    this.writeCatalog({ ...cat, photos: [...cat.photos, { obj, key, caption: String(caption).slice(0, 200), added: Date.now() }] })
    this.publishProfile({ media: [...me.media, obj], photos: isPublic ? [...me.photos, { obj, key }] : me.photos })
    this.commit('Add photo')
    return obj
  }

  // Making a photo public publishes its key in the profile; making it private
  // again stops showing it to new people, but anyone who saw the key keeps it.
  setPhotoPublic (obj, isPublic) {
    const me = this.me()
    const ref = this.catalog().photos.find((p) => p.obj === obj)
    if (!ref) throw new Error('Not one of your photos')
    const others = me.photos.filter((p) => p.obj !== obj)
    if (isPublic && others.length >= schema.MAX_PUBLIC_PHOTOS) throw new Error(`Up to ${schema.MAX_PUBLIC_PHOTOS} photos can be public.`)
    this.publishProfile({ photos: isPublic ? [...others, { obj, key: ref.key }] : others })
    this.commit(isPublic ? 'Publish photo' : 'Unpublish photo')
  }

  removePhoto (obj) {
    const me = this.me()
    const cat = this.catalog()
    if (!cat.photos.some((p) => p.obj === obj)) throw new Error('Not one of your photos')
    this.writeCatalog({ ...cat, photos: cat.photos.filter((p) => p.obj !== obj) })
    this.publishProfile({ media: me.media.filter((m) => m !== obj), photos: me.photos.filter((p) => p.obj !== obj) })
    fs.rmSync(this.file('media', obj + '.bin'), { force: true })
    this.commit('Remove photo')
  }

  // Send a match the keys for specific photos (a snapshot, not ongoing access).
  sharePhotos (toId, objs) {
    if (!this.isMatch(toId)) throw new Error('You can only share photos with a current match.')
    const cat = this.catalog()
    const refs = [...new Set(objs)].map((obj) => cat.photos.find((p) => p.obj === obj))
    if (!refs.length || refs.some((r) => !r)) throw new Error('Choose photos from your own collection.')
    if (refs.length > schema.MAX_GRANT_PHOTOS) throw new Error(`Share at most ${schema.MAX_GRANT_PHOTOS} photos at a time.`)
    this.send('grant', toId, { photos: refs.map(({ obj, key }) => ({ obj, key })) }, { commit: false })
    const already = new Set(cat.grants[toId] || [])
    for (const r of refs) already.add(r.obj)
    this.writeCatalog({ ...cat, grants: { ...cat.grants, [toId]: [...already] } })
    this.commit('Share photos')
  }

  // Photos of `ownerId` that we hold keys for: their public ones, plus any they
  // granted us while we are matched. Our own: everything in the catalog.
  photoRefs (ownerId) {
    if (ownerId === this.myId) {
      const pub = new Set((this.me()?.photos || []).map((p) => p.obj))
      const cat = this.catalog()
      return cat.photos.map((p) => ({
        obj: p.obj, key: p.key, caption: p.caption, public: pub.has(p.obj),
        sharedWith: Object.entries(cat.grants).filter(([, objs]) => objs.includes(p.obj)).map(([id]) => id)
      }))
    }
    const them = this.profile(ownerId)
    if (!them || them.deleted || this.isBlocked(ownerId)) return []
    const refs = new Map(them.photos.map((p) => [p.obj, { ...p, public: true }]))
    if (this.isMatch(ownerId)) {
      for (const e of this.events()) {
        if (e.type !== 'grant' || e.from !== ownerId) continue
        for (const p of e.photos) if (!refs.has(p.obj)) refs.set(p.obj, { ...p, public: false })
      }
    }
    // Only objects the owner still lists; removed photos disappear from view.
    return [...refs.values()].filter((p) => them.media.includes(p.obj))
  }

  // Decrypted JPEG bytes, or an error if we don't hold a valid key.
  readPhoto (ownerId, obj) {
    const ref = this.photoRefs(ownerId).find((p) => p.obj === obj)
    if (!ref) throw new Error('You do not have access to that photo.')
    let file
    try { file = fs.readFileSync(this.file('media', obj + '.bin')) } catch { throw new Error('Photo not replicated yet. Sync and try again.') }
    const bytes = c.decryptMedia(ownerId, file, ref.key)
    if (!bytes) throw new Error('Photo failed its integrity check.')
    return bytes
  }

  // ----------------------------------------------------------------- mail

  writeMail (inner, recipientBoxPub) {
    const body = JSON.stringify(c.seal(recipientBoxPub, inner)) + '\n'
    const name = c.sha256(body)
    fs.writeFileSync(this.file('mail', name + '.json'), body)
    this._mailCache.set(name + '.json', this.verifyInner(inner))
    return name
  }

  // Highest sequence number we have used, recovered from our sealed self-copies.
  nextSeq () {
    let n = 0
    for (const e of this.events()) if (e.from === this.myId && e.n > n) n = e.n
    return n + 1
  }

  // Seal one copy to the recipient and one to ourselves, so our own history can
  // be rebuilt from any replica of the db.
  send (type, toId, extra = {}, { commit = true } = {}) {
    this.requireInit()
    if (!this.me()) throw new Error('Create your profile first.')
    const them = this.profile(toId)
    if (!them || them.deleted) throw new Error('That profile no longer exists.')
    const inner = c.sign(this.identity, { type, from: this.myId, to: toId, at: Date.now(), n: this.nextSeq(), ...extra })
    if (!schema.validEnvelopePayload(inner.payload)) throw new Error('Invalid ' + type)
    this.writeMail(inner, them.box)
    this.writeMail(inner, this.identity.box.pub)
    if (commit) this.commit('Add mail')
  }

  like (toId) {
    if (this.isBlocked(toId)) throw new Error('Unblock them first.')
    this.send('like', toId)
  }

  unlike (toId) { this.send('unlike', toId) }

  message (toId, text) {
    if (!this.isMatch(toId)) throw new Error('You can only message people you have matched with.')
    this.send('msg', toId, { text: String(text).slice(0, 2000) })
  }

  pass (toId) {
    const state = this.readState()
    state.passed = [...new Set([...(state.passed || []), toId])]
    this.writeState(state)
  }

  unpass (toId) {
    const state = this.readState()
    state.passed = (state.passed || []).filter((id) => id !== toId)
    this.writeState(state)
  }

  // Blocking is private: it unlikes them and hides them locally. The block
  // list lives in our sealed catalog so it survives a restore.
  block (id) {
    if (this.relations().get(id)?.iLike) this.send('unlike', id, {}, { commit: false })
    const cat = this.catalog()
    this.writeCatalog({ ...cat, blocked: [...new Set([...cat.blocked, id])] })
    this.commit('Update vault')
  }

  unblock (id) {
    const cat = this.catalog()
    this.writeCatalog({ ...cat, blocked: cat.blocked.filter((b) => b !== id) })
    this.commit('Update vault')
  }

  isBlocked (id) { return this.catalog().blocked.includes(id) }

  verifyInner (inner) {
    const p = inner && inner.payload
    if (!schema.validEnvelopePayload(p)) return null
    if (p.to !== this.myId && p.from !== this.myId) return null // re-sealed to the wrong person
    return c.verify(inner, p.from) ? p : null
  }

  // All likes/messages/grants involving us, verified and deduplicated.
  events () {
    const seen = new Set()
    const out = []
    for (const f of fs.readdirSync(this.file('mail'))) {
      if (!MAIL_RE.test('mail/' + f)) continue
      if (!this._mailCache.has(f)) {
        let result = null
        try { result = this.verifyInner(c.open(this.identity, JSON.parse(fs.readFileSync(this.file('mail', f), 'utf8')))) } catch {}
        this._mailCache.set(f, result)
      }
      const e = this._mailCache.get(f)
      if (!e) continue
      const key = c.canonical(e)
      if (seen.has(key)) continue
      seen.add(key)
      out.push(e)
    }
    return out.sort((a, b) => a.at - b.at)
  }

  // Each side's most recent like/unlike (by that sender's sequence number)
  // decides whether they like the other. A replayed old "like" can't override
  // a later "unlike".
  relations () {
    const rel = new Map()
    const get = (id) => rel.get(id) || rel.set(id, { iLike: false, theyLike: false, myN: 0, theirN: 0, messages: [], grants: [], last: 0 }).get(id)
    for (const e of this.events()) {
      const mine = e.from === this.myId
      const r = get(mine ? e.to : e.from)
      r.last = Math.max(r.last, e.at)
      if (e.type === 'msg') r.messages.push(e)
      if (e.type === 'grant') r.grants.push(e)
      if (e.type !== 'like' && e.type !== 'unlike') continue
      if (mine && e.n > r.myN) { r.myN = e.n; r.iLike = e.type === 'like' }
      if (!mine && e.n > r.theirN) { r.theirN = e.n; r.theyLike = e.type === 'like' }
    }
    return rel
  }

  isMatch (id) {
    const r = this.relations().get(id)
    const p = this.profile(id)
    return !!(r && r.iLike && r.theyLike && p && !p.deleted && !this.isBlocked(id))
  }

  matches () {
    const out = []
    for (const [id, r] of this.relations()) {
      if (!this.isMatch(id)) continue
      out.push({ profile: this.profile(id), messages: r.messages, grants: r.grants, last: r.last })
    }
    return out.sort((a, b) => b.last - a.last)
  }

  // ------------------------------------------------------------ discovery

  discover () {
    const { rank } = require('./match')
    const me = this.me()
    if (!me) return { me: null, candidates: [], admirers: 0 }
    const rel = this.relations()
    const exclude = new Set([...(this.readState().passed || []), ...this.catalog().blocked])
    for (const [id, r] of rel) if (r.iLike) exclude.add(id)
    let admirers = 0
    for (const [id, r] of rel) if (r.theyLike && !r.iLike && !this.isBlocked(id)) admirers++
    return { me, candidates: rank(me, this.profiles(), exclude), admirers }
  }

  // ------------------------------------------------------------- recovery

  // Stores the identity, encrypted under a fresh recovery code, in the public
  // database. Returns the code; it is shown once and never stored locally.
  createBackup () {
    this.requireInit()
    const code = c.newRecoveryCode()
    const { key, locator } = c.recoveryKey(code)
    const payload = { v: 1, id: this.myId, locator, updated: Date.now(), ...c.secretSeal(key, this.identity, BACKUP_AD(locator)) }
    fs.writeFileSync(this.file('backup', locator + '.json'), JSON.stringify(c.sign(this.identity, payload)) + '\n')
    this.commit('Add backup')
    return code
  }

  checkBackup (raw, expectedLocator) {
    if (Buffer.byteLength(raw) > schema.MAX_FILE_BYTES) return null
    let signed
    try { signed = JSON.parse(raw) } catch { return null }
    const p = signed && signed.payload
    const ok = p && p.v === 1 && schema.ID_RE.test(p.id) && p.locator === expectedLocator &&
      Number.isInteger(p.updated) && typeof p.n === 'string' && typeof p.c === 'string' && c.verify(signed, p.id)
    return ok ? p : null
  }

  // Rebuild an identity on a fresh machine from a recovery code and any peer
  // that has replicated the database.
  async restore (code, from) {
    if (fs.existsSync(this.identityPath)) throw new Error(`${this.identityPath} already exists; restore into an empty DATETORRENT_HOME.`)
    const { key, locator } = c.recoveryKey(code)
    this.initDb()
    const peer = this.addPeer(from)
    const err = await this.fetchPeer(peer)
    if (err) throw new Error(`Could not fetch ${from}: ${err}`)
    let raw
    try { raw = this.git(['cat-file', 'blob', `refs/remotes/${peer}/${BRANCH}:backup/${locator}.json`]) } catch {
      throw new Error('No backup for that recovery code on this peer.')
    }
    const p = this.checkBackup(raw, locator)
    const identity = p && c.secretOpen(key, p, BACKUP_AD(locator))
    if (!identity || identity.sign?.pub !== p.id) throw new Error('Recovery code does not open this backup.')
    fs.writeFileSync(this.identityPath, JSON.stringify(identity, null, 2), { mode: 0o600 })
    this._identity = null
    this._catalog = null
    return this.sync()
  }

  // ---------------------------------------------------------------- peers

  peers () {
    const out = this.git(['remote', '-v']).trim()
    const peers = new Map()
    for (const line of out ? out.split('\n') : []) {
      const [name, url] = line.split(/\s+/)
      peers.set(name, url)
    }
    return [...peers].map(([name, url]) => ({ name, url }))
  }

  addPeer (url, name) {
    url = String(url).trim()
    if (/^ext::/i.test(url) || /^-/.test(url)) throw new Error('Refusing unsafe remote URL')
    const existing = this.peers().find((p) => p.url === url)
    if (existing) return existing.name
    name = name || 'peer-' + c.sha256(url).slice(0, 10)
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(name)) throw new Error('Peer names may use letters, digits, . _ -')
    this.git(['remote', 'add', name, url])
    return name
  }

  removePeer (name) { this.git(['remote', 'remove', name]) }

  fetchPeer (name, timeoutMs = 120000) {
    return new Promise((resolve) => {
      execFile('git', [...SAFE_GIT, 'fetch', '--quiet', '--no-tags', name,
        `+refs/heads/${BRANCH}:refs/remotes/${name}/${BRANCH}`], {
        cwd: this.dbDir, timeout: timeoutMs, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
      }, (err, _stdout, stderr) => resolve(err ? String(stderr || err.message).trim() : null))
    })
  }

  // Copy every valid, newer file from `ref` into our working tree.
  ingest (ref) {
    const stats = { profiles: 0, vaults: 0, backups: 0, mail: 0, media: 0, rejected: 0 }
    const listing = (r) => {
      const map = new Map()
      for (const line of this.git(['ls-tree', '-r', '-l', r]).split('\n')) {
        const m = line.match(/^\d+ blob ([0-9a-f]+)\s+(\d+)\t(.+)$/)
        if (m) map.set(m[3], { sha: m[1], size: Number(m[2]) })
      }
      return map
    }
    const local = listing('HEAD')
    const incoming = [...listing(ref)].filter(([file, { sha }]) => local.get(file)?.sha !== sha)
    const blob = (sha, binary) => this.git(['cat-file', 'blob', sha], binary ? { encoding: 'buffer' } : {})
    const reject = () => { stats.rejected++ }

    // Profiles first: media is only accepted if a verified profile lists it.
    for (const [file, { sha, size }] of incoming) {
      const m = PROFILE_RE.exec(file)
      if (!m) continue
      if (size > schema.MAX_FILE_BYTES) { reject(); continue }
      const raw = blob(sha)
      const next = this.checkProfile(raw, m[1])
      if (!next) { reject(); continue }
      const current = this.profile(m[1])
      if (current && current.updated >= next.updated) continue
      // Key pinning: a profile can't silently swap the key its mail is sealed to.
      if (current && current.box !== next.box) { reject(); continue }
      if (m[1] === this.myId && next.box !== this.identity.box.pub) { reject(); continue }
      fs.writeFileSync(this.file(file), raw)
      stats.profiles++
    }

    for (const [file, { sha, size }] of incoming) {
      let m
      if ((m = VAULT_RE.exec(file))) {
        if (size > schema.MAX_VAULT_BYTES) { reject(); continue }
        const raw = blob(sha)
        const next = this.checkVault(raw, m[1])
        if (!next) { reject(); continue }
        let current = null
        try { current = this.checkVault(fs.readFileSync(this.file(file), 'utf8'), m[1]) } catch {}
        if (current && current.updated >= next.updated) continue
        fs.writeFileSync(this.file(file), raw)
        if (m[1] === this.myId) this._catalog = null
        stats.vaults++
      } else if ((m = BACKUP_RE.exec(file))) {
        if (size > schema.MAX_FILE_BYTES) { reject(); continue }
        const raw = blob(sha)
        if (!this.checkBackup(raw, m[1])) { reject(); continue }
        if (fs.existsSync(this.file(file))) continue
        fs.writeFileSync(this.file(file), raw)
        stats.backups++
      } else if ((m = MAIL_RE.exec(file))) {
        if (size > schema.MAX_FILE_BYTES) { reject(); continue }
        const raw = blob(sha)
        let box
        try { box = JSON.parse(raw) } catch {}
        if (!box || box.v !== 2 || typeof box.c !== 'string' || c.sha256(raw) !== m[1]) { reject(); continue }
        if (fs.existsSync(this.file(file))) continue
        fs.writeFileSync(this.file(file), raw)
        stats.mail++
      }
    }

    const vouched = new Set(this.profiles().flatMap((p) => p.media))
    for (const [file, { sha, size }] of incoming) {
      const m = MEDIA_RE.exec(file)
      if (!m) continue
      if (fs.existsSync(this.file(file))) continue
      if (size > schema.MAX_MEDIA_BYTES || !vouched.has(m[1])) { reject(); continue }
      const bytes = blob(sha, true)
      if (c.sha256(bytes) !== m[1]) { reject(); continue }
      fs.writeFileSync(this.file(file), bytes)
      stats.media++
    }
    return stats
  }

  // Newly-seen profiles advertise their own GitTorrent URL; follow them.
  discoverPeers () {
    const known = new Set(this.peers().map((p) => p.url))
    const mine = this.me()?.gittorrent
    const added = []
    for (const p of this.profiles()) {
      const url = p.gittorrent
      if (!url || url === mine || known.has(url) || !schema.GITTORRENT_URL_RE.test(url)) continue
      added.push(this.addPeer(url, 'peer-' + p.id.slice(0, 10)))
      known.add(url)
    }
    return added
  }

  async sync ({ log = () => {}, rounds = 2 } = {}) {
    this.requireInit()
    const keys = ['profiles', 'vaults', 'backups', 'mail', 'media', 'rejected']
    const total = { failed: [], discovered: [] }
    for (const k of keys) total[k] = 0
    const done = new Set()
    // A second round pulls from peers discovered in the first.
    for (let round = 0; round < rounds; round++) {
      const todo = this.peers().filter((p) => !done.has(p.name))
      if (!todo.length) break
      // Fetch in parallel, ingest one at a time: ingest writes the working tree.
      const fetched = await Promise.all(todo.map(async (peer) => {
        done.add(peer.name)
        log(`fetching ${peer.name} (${peer.url})`)
        return { peer, err: await this.fetchPeer(peer.name) }
      }))
      for (const { peer, err } of fetched) {
        if (err) { total.failed.push({ ...peer, error: err }); log(`  ${peer.name}: ${err}`); continue }
        try {
          const s = this.ingest(`refs/remotes/${peer.name}/${BRANCH}`)
          for (const k of keys) total[k] += s[k]
          log(`  ${peer.name}: +${s.profiles} profiles, +${s.media} photos, +${s.mail} mail, ${s.rejected} rejected`)
        } catch (e) {
          total.failed.push({ ...peer, error: e.message })
        }
      }
      total.discovered.push(...this.discoverPeers())
    }
    this._mailCache.clear()
    this._catalog = null
    this.commit(`Sync: +${total.profiles} profiles, +${total.media} photos, +${total.mail} mail`)
    return total
  }
}

module.exports = { Store, defaultHome, DB_NAME, BRANCH }
