#!/usr/bin/env node
'use strict'

const { parseArgs } = require('node:util')
const fs = require('node:fs')
const { Store } = require('../lib/store')
const c = require('../lib/crypto')
const gt = require('../lib/gittorrent')

const HELP = `datetorrent - serverless dating over GitTorrent

Setup
  init [--from <url>]            create your keys and local database (optionally seed a peer)
  whoami                         show your id and GitTorrent URLs
  profile                        show your profile
  profile --name .. --age .. --gender .. --seeking a,b --ages 25-40
          --region "City, ST" --bio ".." --interests x,y,z
  profile --delete               publish a removal tombstone

Photos (encrypted on this machine, one key per photo)
  photo add <file.jpg> [--public] [--caption ".."]   metadata (GPS etc.) is stripped
  photo ls                       your photos, who can see them
  photo public <obj> | photo private <obj> | photo rm <obj>
  photo share <id> <obj> [obj..] give a match the keys to specific photos
  photo get <owner-id> <obj> <out.jpg>

Dating (all matching happens on this machine)
  discover [--limit 10]          ranked compatible profiles
  like <id> | pass <id> | unlike <id>
  block <id> | unblock <id>      private: unlikes and hides them
  matches                        mutual likes
  msg <id> "text"                message a match
  chat <id>                      show a conversation

Recovery
  backup                         print a new recovery code (store it offline)
  restore <code> --from <url>    rebuild your identity from any peer

Network
  peer add <url> [name]          gittorrent://<hash>/datetorrent-db, git://, https://, or a path
  peer ls | peer rm <name>
  sync                           pull from all peers, verify, merge
  serve [--sync-minutes 10] [--git-daemon] [--no-app]
                                 host your database (and this app) with gittorrentd
  ui [--port 4242]               open the local web app

Data lives in $DATETORRENT_HOME (default ~/.datetorrent).
`

const short = (id) => id.slice(0, 8)
const line = (p) => `${short(p.id)}  ${p.name}, ${p.age} · ${p.gender} · ${p.region || 'somewhere'}`

async function main () {
  const argv = process.argv.slice(2)
  const cmd = argv[0]
  const { values: opt, positionals: pos } = parseArgs({
    args: argv.slice(1),
    allowPositionals: true,
    strict: false,
    options: {
      name: { type: 'string' }, age: { type: 'string' }, gender: { type: 'string' },
      seeking: { type: 'string' }, ages: { type: 'string' }, region: { type: 'string' },
      bio: { type: 'string' }, interests: { type: 'string' }, delete: { type: 'boolean' },
      limit: { type: 'string' }, port: { type: 'string' }, from: { type: 'string' },
      'sync-minutes': { type: 'string' }, 'git-daemon': { type: 'boolean' }, 'no-app': { type: 'boolean' },
      public: { type: 'boolean' }, caption: { type: 'string' }
    }
  })
  await c.ready()
  const store = new Store()

  switch (cmd) {
    case 'init': {
      store.init({ from: opt.from })
      console.log(`Identity and database ready in ${store.home}`)
      console.log(`Your id: ${store.myId}`)
      console.log('Next: datetorrent profile --name ... then datetorrent peer add <url> && datetorrent sync')
      return
    }
    case 'whoami': {
      store.requireInit()
      const s = gt.status(store)
      console.log(`id        ${store.myId}`)
      console.log(`home      ${store.home}`)
      console.log(`database  ${s.dbUrl || '(run `datetorrent serve` to get a GitTorrent URL)'}`)
      if (s.appUrl) console.log(`app       ${s.appUrl}`)
      console.log(`gittorrent ${s.gittorrentd ? 'installed' : 'not installed (npm install --global gittorrent)'}`)
      return
    }
    case 'profile': {
      store.requireInit()
      if (opt.delete) { store.deleteProfile(); console.log('Removal published. Note: earlier versions remain in git history.'); return }
      const fields = {}
      for (const k of ['name', 'age', 'gender', 'seeking', 'region', 'bio', 'interests']) if (opt[k] !== undefined) fields[k] = opt[k]
      if (opt.ages) [fields.ageMin, fields.ageMax] = opt.ages.split('-')
      if (Object.keys(fields).length) store.saveProfile(fields)
      const me = store.me()
      if (!me) { console.log('No profile yet. Set one with --name --age --gender --seeking ...'); return }
      console.log(line(me))
      console.log(`  seeking ${me.seeking.join(', ')} aged ${me.ageMin}-${me.ageMax}`)
      console.log(`  interests ${me.interests.join(', ') || '-'}`)
      if (me.bio) console.log(`  "${me.bio}"`)
      return
    }
    case 'discover': {
      store.requireInit()
      const { me, candidates, admirers } = store.discover()
      if (!me) throw new Error('Create your profile first.')
      if (admirers) console.log(`${admirers} ${admirers === 1 ? 'person likes' : 'people like'} you. Like them back to match.\n`)
      if (!candidates.length) console.log('No compatible profiles yet. Add peers and sync.')
      for (const c of candidates.slice(0, parseInt(opt.limit || '10', 10))) {
        console.log(`${String(c.total).padStart(3)}%  ${line(c.profile)}`)
        if (c.shared.length) console.log(`       shared: ${c.shared.join(', ')}`)
        if (c.profile.bio) console.log(`       "${c.profile.bio.slice(0, 120)}"`)
      }
      return
    }
    case 'like':
    case 'unlike':
    case 'pass': {
      store.requireInit()
      const id = store.resolveId(pos[0])
      store[cmd](id)
      if (cmd === 'like' && store.matches().some((m) => m.profile.id === id)) console.log(`It's a match with ${store.profile(id).name}!`)
      else console.log(`${{ like: 'liked', unlike: 'unliked', pass: 'passed on' }[cmd]} ${short(id)}${cmd === 'pass' ? '' : ' (sealed; run sync/serve to deliver)'}`)
      return
    }
    case 'block':
    case 'unblock': {
      store.requireInit()
      const id = store.resolveId(pos[0])
      store[cmd](id)
      console.log(`${cmd}ed ${short(id)}`)
      return
    }
    case 'photo': {
      store.requireInit()
      const [sub, ...args] = pos
      const obj = (prefix) => {
        const hit = store.photoRefs(store.myId).filter((p) => p.obj.startsWith(String(prefix || '')))
        if (hit.length !== 1) throw new Error(`"${prefix}" doesn't identify exactly one of your photos`)
        return hit[0].obj
      }
      if (sub === 'add') {
        const id = store.addPhoto(fs.readFileSync(args[0]), { isPublic: !!opt.public, caption: opt.caption || '' })
        console.log(`added ${short(id)} (${opt.public ? 'public' : 'private'})`)
      } else if (sub === 'public' || sub === 'private') {
        store.setPhotoPublic(obj(args[0]), sub === 'public')
        console.log(sub === 'private' ? 'Now private for new viewers. Anyone who already has its key keeps it.' : 'Now public.')
      } else if (sub === 'rm') {
        store.removePhoto(obj(args[0]))
        console.log('Removed. Matches you shared it with may still have a copy.')
      } else if (sub === 'share') {
        const to = store.resolveId(args[0])
        store.sharePhotos(to, args.slice(1).map(obj))
        console.log(`Shared ${args.length - 1} photo(s) with ${store.profile(to).name}. Sync or keep \`serve\` running to deliver.`)
      } else if (sub === 'get') {
        const owner = store.resolveId(args[0])
        const ref = store.photoRefs(owner).find((p) => p.obj.startsWith(args[1] || '-'))
        if (!ref) throw new Error('You do not have access to that photo.')
        fs.writeFileSync(args[2], store.readPhoto(owner, ref.obj))
        console.log(`wrote ${args[2]}`)
      } else {
        const names = (ids) => ids.map((id) => store.profile(id)?.name || short(id)).join(', ')
        const mine = store.photoRefs(store.myId)
        if (!mine.length) console.log('No photos yet: datetorrent photo add <file.jpg>')
        for (const p of mine) {
          console.log(`${short(p.obj)}  ${p.public ? 'public ' : 'private'}  ${p.caption || ''}${p.sharedWith.length ? `  shared with ${names(p.sharedWith)}` : ''}`)
        }
      }
      return
    }
    case 'backup': {
      const code = store.createBackup()
      console.log('Your recovery code (shown once; write it down and keep it offline):\n')
      console.log('  ' + code + '\n')
      console.log('With it and any peer that has your data: datetorrent restore <code> --from <url>')
      console.log('Anyone with this code can become you. Running backup again adds a new code; old codes keep working.')
      return
    }
    case 'restore': {
      if (!opt.from) throw new Error('restore needs --from <peer url>')
      const s = await store.restore(pos[0], opt.from)
      console.log(`Restored ${store.myId}. Pulled ${s.profiles} profiles, ${s.media} photos, ${s.mail} mail.`)
      return
    }
    case 'matches': {
      store.requireInit()
      const ms = store.matches()
      if (!ms.length) console.log('No matches yet.')
      for (const m of ms) console.log(`${line(m.profile)}  (${m.messages.length} messages, ${m.grants.length} photo shares)`)
      return
    }
    case 'msg': {
      store.requireInit()
      store.message(store.resolveId(pos[0]), pos.slice(1).join(' '))
      console.log('Sealed and committed. Run sync or keep `serve` running to deliver.')
      return
    }
    case 'chat': {
      store.requireInit()
      const id = store.resolveId(pos[0])
      const m = store.matches().find((x) => x.profile.id === id)
      if (!m) throw new Error('Not a match.')
      for (const e of m.messages) {
        console.log(`[${new Date(e.at).toLocaleString()}] ${e.from === store.myId ? 'you' : m.profile.name}: ${e.text}`)
      }
      return
    }
    case 'peer': {
      store.requireInit()
      const sub = pos[0]
      if (sub === 'add') console.log(`added ${store.addPeer(pos[1], pos[2])}`)
      else if (sub === 'rm') { store.removePeer(pos[1]); console.log('removed') } else for (const p of store.peers()) console.log(`${p.name}\t${p.url}`)
      return
    }
    case 'sync': {
      const s = await store.sync({ log: console.log })
      console.log(`+${s.profiles} profiles, +${s.media} photos, +${s.mail} mail, ${s.rejected} rejected, ${s.discovered.length} peers discovered`)
      if (s.failed.length) process.exitCode = s.failed.length === store.peers().length ? 1 : 0
      return
    }
    case 'serve': {
      const handle = gt.serve(store, {
        syncMinutes: parseInt(opt['sync-minutes'] || '10', 10),
        gitDaemon: !!opt['git-daemon'],
        withApp: !opt['no-app']
      })
      process.on('SIGINT', () => { handle.stop(); process.exit(0) })
      return
    }
    case 'ui': {
      const { createServer } = require('../lib/server')
      const port = parseInt(opt.port || '4242', 10)
      await createServer(store, { port })
      console.log(`DateTorrent is running at http://127.0.0.1:${port}`)
      return
    }
    default:
      console.log(HELP)
  }
}

main().catch((e) => {
  console.error('error: ' + e.message)
  process.exit(1)
})
