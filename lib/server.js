'use strict'
// Local-only web UI. Binds to 127.0.0.1 and rejects requests that don't come
// from its own page: a Host check stops DNS rebinding, and a custom header on
// every write forces a CORS preflight that other websites can't pass.

const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const gt = require('./gittorrent')
const { GENDERS } = require('./schema')

const PUBLIC = path.resolve(__dirname, '..', 'public')
// three.js is served from node_modules so the UI never loads code from a CDN.
const THREE_BUILD = path.dirname(require.resolve('three'))
const VENDOR = {
  '/vendor/three/three.module.js': path.join(THREE_BUILD, 'three.module.js'),
  '/vendor/three/three.core.js': path.join(THREE_BUILD, 'three.core.js')
}
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' }

const card = (p) => p && {
  id: p.id, name: p.name, age: p.age, gender: p.gender, seeking: p.seeking,
  ageMin: p.ageMin, ageMax: p.ageMax, region: p.region, bio: p.bio,
  interests: p.interests, gittorrent: p.gittorrent, updated: p.updated,
  photo: p.photos && p.photos[0] ? p.photos[0].obj : null,
  photos: (p.photos || []).map((x) => x.obj)
}

// Photo metadata for the UI. Keys never leave the server process.
const photoList = (store, owner) => store.photoRefs(owner).map(({ obj, public: isPublic, caption, sharedWith }) => ({ obj, public: isPublic, caption, sharedWith }))

function readBody (req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (d) => {
      size += d.length
      if (size > limit) { reject(new Error('Body too large')); req.destroy() } else chunks.push(d)
    })
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}) } catch { reject(new Error('Invalid JSON')) }
    })
  })
}

function createServer (store, { port = 4242 } = {}) {
  let syncing = null

  const routes = {
    'GET /api/state': () => {
      const initialized = store.initialized
      return {
        initialized,
        genders: GENDERS,
        me: initialized ? card(store.me()) : null,
        myId: initialized ? store.myId : null,
        home: store.home,
        gittorrent: initialized ? gt.status(store) : null
      }
    },
    'POST /api/init': () => { store.init(); return { ok: true } },
    'POST /api/profile': (body) => card(store.saveProfile(body)),
    'POST /api/profile/delete': () => { store.deleteProfile(); return { ok: true } },
    'GET /api/discover': () => {
      const { candidates, admirers } = store.discover()
      return { admirers, candidates: candidates.slice(0, 50).map((x) => ({ profile: card(x.profile), score: x.total, shared: x.shared })) }
    },
    'POST /api/like': (b) => { store.like(store.resolveId(b.id)); return matchedWith(b.id) },
    'POST /api/pass': (b) => { store.pass(store.resolveId(b.id)); return { ok: true } },
    'POST /api/unpass': (b) => { store.unpass(store.resolveId(b.id)); return { ok: true } },
    'POST /api/unlike': (b) => { store.unlike(store.resolveId(b.id)); return { ok: true } },
    'GET /api/matches': () => {
      const mine = new Set(store.photoRefs(store.myId).map((p) => p.obj))
      return store.matches().map((m) => {
        const theirs = new Set(store.photoRefs(m.profile.id).map((p) => p.obj))
        // One timeline: messages and photo shares in order. A shared photo the
        // owner has since removed shows as unavailable instead of vanishing.
        const timeline = [
          ...m.messages.map((e) => ({ kind: 'msg', mine: e.from === store.myId, text: e.text, at: e.at })),
          ...m.grants.map((e) => {
            const isMine = e.from === store.myId
            const owner = isMine ? store.myId : m.profile.id
            const have = isMine ? mine : theirs
            return { kind: 'photos', mine: isMine, owner, at: e.at, photos: e.photos.map((p) => ({ obj: p.obj, available: have.has(p.obj) })) }
          })
        ].sort((a, b) => a.at - b.at)
        return { profile: card(m.profile), photos: photoList(store, m.profile.id), timeline, last: m.last }
      })
    },
    'POST /api/message': (b) => { store.message(store.resolveId(b.id), b.text); return { ok: true } },
    'POST /api/block': (b) => { store.block(store.resolveId(b.id)); return { ok: true } },
    'POST /api/unblock': (b) => { store.unblock(store.resolveId(b.id)); return { ok: true } },
    'GET /api/photos': (_b, url) => photoList(store, store.resolveId(url.searchParams.get('owner') || store.myId)),
    'POST /api/photos': (b) => ({ obj: store.addPhoto(Buffer.from(String(b.data || ''), 'base64'), { isPublic: !!b.public, caption: b.caption || '' }) }),
    'POST /api/photos/public': (b) => { store.setPhotoPublic(b.obj, !!b.public); return { ok: true } },
    'POST /api/photos/remove': (b) => { store.removePhoto(b.obj); return { ok: true } },
    'POST /api/photos/share': (b) => { store.sharePhotos(store.resolveId(b.id), b.objs || []); return { ok: true } },
    'POST /api/backup': () => ({ code: store.createBackup() }),
    'GET /api/peers': () => store.peers(),
    'POST /api/peers': (b) => ({ name: store.addPeer(b.url, b.name || undefined) }),
    'POST /api/peers/remove': (b) => { store.removePeer(b.name); return { ok: true } },
    'POST /api/sync': async () => {
      // Coalesce concurrent clicks into one sync.
      syncing = syncing || store.sync().finally(() => { syncing = null })
      return syncing
    }
  }

  function matchedWith (id) {
    const full = store.resolveId(id)
    return { matched: store.matches().some((m) => m.profile.id === full) }
  }

  const server = http.createServer(async (req, res) => {
    const send = (status, body, type = 'application/json') => {
      res.writeHead(status, {
        'Content-Type': type,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'self'; img-src 'self' blob: data:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; form-action 'none'"
      })
      res.end(type === 'application/json' ? JSON.stringify(body) : body)
    }
    const host = req.headers.host || ''
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return send(403, { error: 'Forbidden host' })

    const url = new URL(req.url, 'http://localhost')
    // Decrypted photo bytes: only for photos this identity holds a key for.
    const photo = url.pathname.match(/^\/api\/photo\/([0-9a-f]{64})\/([0-9a-f]{64})$/)
    if (photo && req.method === 'GET') {
      try { return send(200, store.readPhoto(photo[1], photo[2]), 'image/jpeg') } catch (e) { return send(404, { error: e.message }) }
    }
    if (url.pathname.startsWith('/api/')) {
      const handler = routes[`${req.method} ${url.pathname}`]
      if (!handler) return send(404, { error: 'Not found' })
      if (req.method !== 'GET' && req.headers['x-datetorrent'] !== '1') return send(403, { error: 'Missing X-DateTorrent header' })
      try {
        if (url.pathname !== '/api/state' && url.pathname !== '/api/init') store.requireInit()
        const body = req.method === 'POST' ? await readBody(req, url.pathname === '/api/photos' ? 4 * 1024 * 1024 : undefined) : {}
        return send(200, await handler(body, url))
      } catch (e) {
        return send(400, { error: e.message })
      }
    }

    if (VENDOR[url.pathname]) return send(200, fs.readFileSync(VENDOR[url.pathname]), 'text/javascript')
    const file = path.join(PUBLIC, url.pathname === '/' ? 'index.html' : path.normalize(url.pathname))
    if (!file.startsWith(PUBLIC + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return send(404, 'Not found', 'text/plain')
    send(200, fs.readFileSync(file), TYPES[path.extname(file)] || 'application/octet-stream')
  })

  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)))
}

module.exports = { createServer }
