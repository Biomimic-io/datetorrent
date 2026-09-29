'use strict'
// The acceptance criteria from docs/ARCHITECTURE.md, one test per row.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { Store } = require('../lib/store')
const c = require('../lib/crypto')
const { tmp, person, meshSync, fakeJpeg } = require('./helpers')

test.before(() => c.ready())

// Alice has a public photo and private photos 1-5; Bob and Charlie both match her.
async function scenario () {
  const alice = person('alice', { gender: 'woman', seeking: 'man' })
  const bob = person('bob', { gender: 'man', seeking: 'woman' })
  const charlie = person('charlie', { gender: 'man', seeking: 'woman' })
  const stranger = person('stranger', { gender: 'nonbinary', seeking: 'nonbinary' })
  const pub = alice.addPhoto(fakeJpeg('public'), { isPublic: true })
  const priv = [1, 2, 3, 4, 5].map((i) => alice.addPhoto(fakeJpeg('private' + i)))
  await meshSync(alice, bob, charlie, stranger)
  for (const m of [bob, charlie]) { alice.like(m.myId); m.like(alice.myId) }
  await meshSync(alice, bob, charlie, stranger)
  return { alice, bob, charlie, stranger, pub, priv }
}

const readable = (viewer, owner) => viewer.photoRefs(owner.myId).map((p) => p.obj).sort()

test('photos are stripped of metadata and stored only as ciphertext', async () => {
  const alice = person('alice')
  const jpeg = fakeJpeg('secret-pixels')
  const obj = alice.addPhoto(jpeg)
  const stored = fs.readFileSync(path.join(alice.dbDir, 'media', obj + '.bin'))
  assert.ok(!stored.includes('secret-pixels'), 'no plaintext on disk')
  assert.ok(!stored.includes('GPSLatitude'))
  const back = alice.readPhoto(alice.myId, obj)
  assert.ok(back.includes('secret-pixels'))
  assert.ok(!back.includes('GPSLatitude'), 'EXIF removed before encryption')
  assert.ok(!back.includes('taken at home'), 'comments removed')
})

test('a stranger who copies Alice\'s repository cannot read her private photos or keys', async () => {
  const { alice, stranger, pub, priv } = await scenario()
  // The stranger has every file...
  for (const obj of [pub, ...priv]) assert.ok(fs.existsSync(path.join(stranger.dbDir, 'media', obj + '.bin')))
  // ...but only the public photo is readable.
  assert.deepStrictEqual(readable(stranger, alice), [pub])
  assert.throws(() => stranger.readPhoto(alice.myId, priv[0]), /access/)
  // Her sealed catalog doesn't open for anyone else.
  const vault = JSON.parse(fs.readFileSync(path.join(stranger.dbDir, 'vault', alice.myId + '.json')))
  assert.strictEqual(c.open(stranger.identity, vault.payload.box), null)
  const repoText = execFileSync('git', ['log', '-p', '--all', '--text'], { cwd: stranger.dbDir, maxBuffer: 1e9 }).toString('latin1')
  assert.ok(!repoText.includes('private1'), 'no private plaintext anywhere in history')
})

test('Bob receives three photos and only those become readable', async () => {
  const { alice, bob, pub, priv } = await scenario()
  alice.sharePhotos(bob.myId, [priv[0], priv[1], priv[2]])
  await meshSync(alice, bob)
  assert.deepStrictEqual(readable(bob, alice), [pub, priv[0], priv[1], priv[2]].sort())
  assert.ok(bob.readPhoto(alice.myId, priv[1]).includes('private2'))
  assert.throws(() => bob.readPhoto(alice.myId, priv[3]), /access/)
})

test('Charlie receives a different selection and permissions stay independent', async () => {
  const { alice, bob, charlie, pub, priv } = await scenario()
  alice.sharePhotos(bob.myId, [priv[0], priv[1]])
  alice.sharePhotos(charlie.myId, [priv[4]])
  await meshSync(alice, bob, charlie)
  assert.deepStrictEqual(readable(bob, alice), [pub, priv[0], priv[1]].sort())
  assert.deepStrictEqual(readable(charlie, alice), [pub, priv[4]].sort())
  // Grants are sealed to their recipient: Charlie can't use Bob's.
  assert.ok(charlie.events().every((e) => e.to === charlie.myId || e.from === charlie.myId))
})

test('a host that alters an encrypted object is rejected', async () => {
  const { alice, bob, priv } = await scenario()
  alice.sharePhotos(bob.myId, [priv[0]])
  await meshSync(alice, bob)

  // A malicious host serves a modified object under the same name.
  const host = person('host')
  host.addPeer(alice.dbDir, 'alice')
  await host.sync()
  const file = path.join(host.dbDir, 'media', priv[1] + '.bin')
  const bytes = fs.readFileSync(file)
  bytes[bytes.length - 5] ^= 0xff
  fs.writeFileSync(file, bytes)
  host.commit('tamper')
  const fresh = new Store(path.join(tmp, 'fresh')).init()
  fresh.addPeer(host.dbDir, 'host')
  const s = await fresh.sync()
  assert.ok(s.rejected >= 1)
  assert.ok(!fs.existsSync(path.join(fresh.dbDir, 'media', priv[1] + '.bin')))

  // And if tampered bytes do reach a reader, decryption refuses them.
  const bobCopy = path.join(bob.dbDir, 'media', priv[0] + '.bin')
  const b = fs.readFileSync(bobCopy)
  b[b.length - 5] ^= 0xff
  fs.writeFileSync(bobCopy, b)
  assert.throws(() => bob.readPhoto(alice.myId, priv[0]), /integrity/)
})

test('a substituted identity key does not silently receive private content', async () => {
  const { alice, bob, priv } = await scenario()
  // A hostile replica swaps Bob's box key for its own in a profile signed by itself.
  const attacker = c.generateIdentity()
  const evil = { ...bob.me(), box: attacker.box.pub, updated: Date.now() + 5000 }
  const relay = person('relay')
  fs.writeFileSync(path.join(relay.dbDir, 'profiles', bob.myId + '.json'), JSON.stringify(c.sign(attacker, evil)))
  relay.commit('swap')
  alice.addPeer(relay.dbDir, 'relay')
  await alice.sync()
  assert.strictEqual(alice.profile(bob.myId).box, bob.identity.box.pub, 'forged profile rejected')

  // Even Bob himself can't rotate his box key without a rotation protocol: pinned.
  const rotated = { ...bob.me(), box: c.generateIdentity().box.pub, updated: Date.now() + 10000 }
  fs.writeFileSync(path.join(bob.dbDir, 'profiles', bob.myId + '.json'), JSON.stringify(c.sign(bob.identity, rotated)))
  bob.commit('rotate')
  await alice.sync()
  assert.strictEqual(alice.profile(bob.myId).box, bob.identity.box.pub, 'key change is not accepted silently')

  // So a grant to Bob is sealed to the key Alice pinned, which only Bob holds.
  alice.sharePhotos(bob.myId, [priv[0]])
  const newest = fs.readdirSync(path.join(alice.dbDir, 'mail')).map((f) => JSON.parse(fs.readFileSync(path.join(alice.dbDir, 'mail', f))))
  assert.ok(newest.every((box) => c.open(attacker, box) === null))
})

test('after Alice unmatches Bob, new content stays inaccessible to him', async () => {
  const { alice, bob, priv } = await scenario()
  alice.sharePhotos(bob.myId, [priv[0]])
  await meshSync(alice, bob)
  alice.unlike(bob.myId)
  assert.throws(() => alice.sharePhotos(bob.myId, [priv[1]]), /current match/)
  const later = alice.addPhoto(fakeJpeg('after-unmatch'))
  await meshSync(alice, bob)
  assert.ok(!bob.isMatch(alice.myId))
  assert.ok(!readable(bob, alice).includes(later))
  assert.ok(!readable(bob, alice).includes(priv[1]))
  assert.throws(() => bob.readPhoto(alice.myId, later), /access/)
})

test('Bob keeps an old photo key: the app makes no false promise of deletion', async () => {
  const { alice, bob, priv } = await scenario()
  alice.sharePhotos(bob.myId, [priv[0]])
  await meshSync(alice, bob)
  const key = bob.photoRefs(alice.myId).find((p) => p.obj === priv[0]).key
  const ciphertext = fs.readFileSync(path.join(bob.dbDir, 'media', priv[0] + '.bin'))
  alice.unlike(bob.myId)
  alice.removePhoto(priv[0])
  await meshSync(alice, bob)
  // The app stops showing it...
  assert.throws(() => bob.readPhoto(alice.myId, priv[0]), /access/)
  // ...but a Bob who saved the key and bytes can still decrypt them. This is
  // the documented limit, not a bug.
  assert.ok(c.decryptMedia(alice.myId, ciphertext, key).includes('private1'))
})

test('Alice moves hosting and her identity and grants keep working', async () => {
  const { alice, bob, priv } = await scenario()
  alice.sharePhotos(bob.myId, [priv[0]])
  await meshSync(alice, bob)
  // Alice's old host disappears. She copies her repo to a new host (any git
  // remote) and keeps publishing there; Bob only learns the new URL.
  const newHost = path.join(tmp, 'new-host.git')
  execFileSync('git', ['clone', '-q', '--bare', alice.dbDir, newHost])
  for (const p of bob.peers()) bob.removePeer(p.name)
  bob.addPeer(newHost, 'alice-new-host')
  alice.saveProfile({ bio: 'moved hosts' })
  execFileSync('git', ['push', '-q', newHost, 'master'], { cwd: alice.dbDir })
  await bob.sync()
  assert.strictEqual(bob.profile(alice.myId).bio, 'moved hosts')
  assert.strictEqual(bob.profile(alice.myId).id, alice.myId, 'same identity')
  assert.ok(bob.isMatch(alice.myId))
  assert.ok(bob.readPhoto(alice.myId, priv[0]).includes('private1'))
})

test('restoring from a recovery code works without exposing keys to the host', async () => {
  const { alice, bob, priv } = await scenario()
  alice.sharePhotos(bob.myId, [priv[0]])
  alice.block(bob.myId)
  const code = alice.createBackup()
  await meshSync(alice, bob)

  // Bob's replica (the "host") holds Alice's backup but can't open it.
  const backups = fs.readdirSync(path.join(bob.dbDir, 'backup')).filter((f) => f.endsWith('.json'))
  assert.strictEqual(backups.length, 1)
  const raw = fs.readFileSync(path.join(bob.dbDir, 'backup', backups[0]), 'utf8')
  assert.ok(!raw.includes(alice.identity.sign.priv) && !raw.includes(alice.identity.box.priv))

  // Alice loses her laptop and restores from Bob's replica with only the code.
  const restored = new Store(path.join(tmp, 'alice-new-laptop'))
  await restored.restore(code, bob.dbDir)
  assert.strictEqual(restored.myId, alice.myId)
  assert.strictEqual(restored.me().name, 'alice')
  assert.deepStrictEqual(restored.photoRefs(restored.myId).map((p) => p.obj).sort(), alice.photoRefs(alice.myId).map((p) => p.obj).sort())
  assert.ok(restored.readPhoto(restored.myId, priv[3]).includes('private4'))
  assert.ok(restored.isBlocked(bob.myId), 'block list restored')
  assert.ok(restored.nextSeq() > 1, 'sequence numbers continue')

  await assert.rejects(new Store(path.join(tmp, 'wrong')).restore(c.newRecoveryCode(), bob.dbDir), /No backup/)
})
