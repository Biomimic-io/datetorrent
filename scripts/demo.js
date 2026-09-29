#!/usr/bin/env node
'use strict'
// Builds a small fake network on disk so you can try the app without peers:
//   node scripts/demo.js /tmp/dt-demo
// creates one replica per demo person, cross-links them, and prints a peer
// URL to add from your own install. Some of them already like "you" once you
// pass your id: node scripts/demo.js /tmp/dt-demo <your-id>

const path = require('node:path')
const fs = require('node:fs')
const { Store } = require('../lib/store')
const c = require('../lib/crypto')
const { photosFor } = require('./photos')

const PEOPLE = [
  ['Ada', 31, 'woman', 'man,woman', 'climbing,jazz,sourdough,cycling', 'Portland, OR', 'Weekend crag rat, weekday data nerd. Will judge your bread.'],
  ['Bo', 33, 'man', 'woman', 'jazz,tea,film photography', 'Portland, OR', 'I develop my own film and my own opinions about pu-erh.'],
  ['Cyra', 28, 'nonbinary', 'woman,nonbinary,man', 'board games,climbing,synths', 'Seattle, WA', 'Modular synth hoarder. Catan is a contact sport.'],
  ['Dev', 36, 'man', 'woman,man', 'cycling,cooking,sourdough', 'Salem, OR', 'Long rides, longer ferments.'],
  ['Emi', 29, 'woman', 'man', 'hiking,jazz,poetry', 'Eugene, OR', 'Trail miles and open mics.'],
  ['Farah', 34, 'woman', 'woman', 'cooking,film photography,hiking', 'Portland, OR', 'Cast iron evangelist.'],
  ['Gus', 41, 'man', 'woman', 'sailing,jazz', 'Astoria, OR', 'Boat is small, heart is big.'],
  ['Hana', 26, 'woman', 'man,woman', 'synths,climbing,tea', 'Portland, OR', 'Bouldering in the morning, patching cables at night.']
]

const root = path.resolve(process.argv[2] || 'datetorrent-demo')
const likeId = process.argv[3]
fs.mkdirSync(root, { recursive: true })

;(async () => {
  await c.ready()
  const stores = PEOPLE.map(([name, age, gender, seeking, interests, region, bio]) => {
    const s = new Store(path.join(root, name.toLowerCase())).init()
    s.saveProfile({ name, age, gender, seeking, interests, region, bio, ageMin: 24, ageMax: 45 })
    // Two public placeholder photos and one private one per person.
    photosFor(name, interests.split(','), 3).forEach((jpg, i) => s.addPhoto(jpg, { isPublic: i < 2 }))
    return s
  })

  // Sample photos you can upload as yourself.
  const samples = path.join(root, 'samples')
  fs.mkdirSync(samples, { recursive: true })
  photosFor('You', ['climbing', 'sailing', 'jazz'], 4).forEach((jpg, i) => fs.writeFileSync(path.join(samples, `you-${i + 1}.jpg`), jpg))

  // A hub replica that has pulled from everyone: the one URL you need.
  const hub = new Store(path.join(root, 'hub')).init()
  for (const s of stores) hub.addPeer(s.dbDir, path.basename(s.home))
  await hub.sync()

  if (likeId) {
    // Pull the real user's profile from their replica so demo people can like them.
    const userDb = path.join(process.env.DATETORRENT_HOME || path.join(require('node:os').homedir(), '.datetorrent'), 'datetorrent-db')
    for (const s of stores.slice(0, 4)) {
      s.addPeer(userDb, 'you')
      await s.sync()
      try { s.like(s.resolveId(likeId)) } catch (e) { console.warn(`${path.basename(s.home)}: ${e.message}`) }
      hub.addPeer(s.dbDir, path.basename(s.home))
    }
    await hub.sync()
  }
  console.log(`Demo network with ${stores.length} people in ${root}`)
  console.log(`Add it with:  datetorrent peer add ${hub.dbDir} demo && datetorrent sync`)
})()
