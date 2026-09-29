'use strict'
// Hosting via GitTorrent (https://github.com/cjb/GitTorrent).
//
// `gittorrentd` serves every `*/.git` repo in its working directory that has a
// `git-daemon-export-ok` file, announces the commits on the BitTorrent DHT and
// publishes a BEP 44 mutable key describing them. The DATETORRENT_HOME dir is
// laid out so gittorrentd can run straight from it:
//
//   ~/.datetorrent/
//     ed25519.key          gittorrentd's DHT key (created by gittorrentd)
//     datetorrent-db/      the database          -> gittorrent://<hash>/datetorrent-db
//     datetorrent/         optional link to this app's repo -> gittorrent://<hash>/datetorrent

const fs = require('node:fs')
const path = require('node:path')
const { spawn, execFileSync } = require('node:child_process')
const { DB_NAME } = require('./store')

const APP_ROOT = path.resolve(__dirname, '..')

function which (bin) {
  const local = path.join(APP_ROOT, 'node_modules', '.bin', bin)
  if (fs.existsSync(local)) return local
  try { return execFileSync('which', [bin], { encoding: 'utf8' }).trim() || null } catch { return null }
}

function status (store) {
  let saved = {}
  try { saved = JSON.parse(fs.readFileSync(path.join(store.home, 'gittorrent.json'), 'utf8')) } catch {}
  return {
    gittorrentd: which('gittorrentd'),
    remoteHelper: which('git-remote-gittorrent'),
    hash: saved.hash || null,
    dbUrl: saved.hash ? `gittorrent://${saved.hash}/${DB_NAME}` : null,
    appUrl: saved.hash && fs.existsSync(path.join(store.home, 'datetorrent')) ? `gittorrent://${saved.hash}/datetorrent` : null
  }
}

// Expose this app's own source repo next to the database so peers can
// `git clone gittorrent://<hash>/datetorrent` to install the app.
function linkAppRepo (store) {
  if (!fs.existsSync(path.join(APP_ROOT, '.git'))) return null
  const link = path.join(store.home, 'datetorrent')
  if (!fs.existsSync(link)) fs.symlinkSync(APP_ROOT, link, 'dir')
  fs.writeFileSync(path.join(APP_ROOT, '.git', 'git-daemon-export-ok'), '')
  return link
}

function recordHash (store, hash, log) {
  const file = path.join(store.home, 'gittorrent.json')
  let prev = {}
  try { prev = JSON.parse(fs.readFileSync(file, 'utf8')) } catch {}
  if (prev.hash === hash) return
  fs.writeFileSync(file, JSON.stringify({ hash, at: Date.now() }, null, 2))
  const url = `gittorrent://${hash}/${DB_NAME}`
  log(`your database is at ${url}`)
  // Advertise it in our profile so anyone who sees us can replicate from us.
  const me = store.me()
  if (me && !me.deleted && me.gittorrent !== url) {
    store.saveProfile({ gittorrent: url })
    log('profile updated with your GitTorrent URL (restart pending to announce it)')
  }
}

// GitTorrent's default bootstrap hosts (dht/core.gittorrent.org) no longer
// resolve. gittorrentd reads `rc` config from its cwd, so point it at public
// mainline DHT routers unless the user already wrote their own .gittorrentrc.
const BOOTSTRAP = ['router.bittorrent.com:6881', 'dht.transmissionbt.com:6881', 'router.utorrent.com:6881']

function writeRc (store) {
  const rc = path.join(store.home, '.gittorrentrc')
  if (!fs.existsSync(rc)) fs.writeFileSync(rc, JSON.stringify({ dht: { bootstrap: BOOTSTRAP } }, null, 2) + '\n')
}

const headOf = (store) => store.git(['rev-parse', 'HEAD']).trim()

// Runs gittorrentd, re-announcing when the database changes (gittorrentd only
// announces refs at start-up) and pulling from peers every `syncMinutes`.
function serve (store, { log = console.log, syncMinutes = 10, withApp = true, gitDaemon = false } = {}) {
  store.requireInit()
  const bin = which('gittorrentd')
  writeRc(store)
  if (withApp) {
    const link = linkAppRepo(store)
    if (link) log(`also serving the app itself from ${link}`)
  }

  const children = new Set()
  let daemon = null
  let announcedHead = headOf(store)
  let stopping = false

  const startGittorrentd = () => {
    if (!bin) return
    daemon = spawn(bin, [], { cwd: store.home, stdio: ['ignore', 'pipe', 'pipe'] })
    children.add(daemon)
    const onData = (buf) => {
      for (const line of String(buf).split('\n').filter(Boolean)) {
        const m = line.match(/hash=\s*([0-9a-f]{40})/)
        if (m) recordHash(store, m[1], log)
        else if (/Announc|error|Error|Received/.test(line)) log('[gittorrentd] ' + line.trim())
      }
    }
    daemon.stdout.on('data', onData)
    daemon.stderr.on('data', onData)
    daemon.on('exit', (code) => {
      children.delete(daemon)
      if (!stopping && code !== null) log(`[gittorrentd] exited with code ${code}`)
    })
    log(`gittorrentd started in ${store.home}`)
  }

  if (bin) {
    startGittorrentd()
  } else {
    log('gittorrentd not found. Install GitTorrent with `npm install --global gittorrent`.')
  }

  // Plain git:// fallback. Peers can then use gittorrent://<your-host>/datetorrent-db
  // (GitTorrent resolves the head over git:// and fetches objects over BitTorrent)
  // or git://<your-host>/datetorrent-db directly.
  if (gitDaemon) {
    const gd = spawn('git', ['daemon', '--reuseaddr', `--base-path=${store.home}`, store.home], { stdio: 'inherit' })
    children.add(gd)
    log(`git daemon serving ${store.home} on port 9418`)
  }

  const tick = async () => {
    try {
      const s = await store.sync({ log: () => {} })
      if (s.profiles || s.mail || s.discovered.length) {
        log(`sync: +${s.profiles} profiles, +${s.mail} mail, ${s.discovered.length} new peers`)
      }
    } catch (e) {
      log('sync failed: ' + e.message)
    }
    const head = headOf(store)
    if (head !== announcedHead && daemon) {
      log('database changed, re-announcing on the DHT')
      announcedHead = head
      daemon.kill()
      startGittorrentd()
    }
  }
  const timer = setInterval(tick, Math.max(1, syncMinutes) * 60 * 1000)
  tick()

  return {
    stop () {
      stopping = true
      clearInterval(timer)
      for (const child of children) child.kill()
    }
  }
}

module.exports = { serve, status, which, linkAppRepo }
