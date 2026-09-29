'use strict'
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { Store } = require('../lib/store')
const c = require('../lib/crypto')
const { score, compatible } = require('../lib/match')
const { tmp, person, meshSync } = require('./helpers')

test.before(() => c.ready())

test('crypto: signatures and sealed boxes', () => {
  const a = c.generateIdentity()
  const b = c.generateIdentity()
  const signed = c.sign(a, { hello: 'world', n: [1, 2] })
  assert.ok(c.verify(signed, a.sign.pub))
  assert.ok(!c.verify(signed, b.sign.pub))
  assert.ok(!c.verify({ ...signed, payload: { hello: 'mars', n: [1, 2] } }, a.sign.pub))
  const box = c.seal(b.box.pub, { secret: 1 })
  assert.deepStrictEqual(c.open(b, box), { secret: 1 })
  assert.strictEqual(c.open(a, box), null)
})

test('match: compatibility is mutual and scores favour shared interests', () => {
  const base = { ageMin: 25, ageMax: 40, region: 'Portland, OR', interests: [] }
  const ada = { ...base, id: 'a', age: 31, gender: 'woman', seeking: ['man'], interests: ['climbing', 'jazz'] }
  const bo = { ...base, id: 'b', age: 33, gender: 'man', seeking: ['woman'], interests: ['jazz', 'climbing', 'tea'] }
  const cy = { ...base, id: 'c', age: 33, gender: 'man', seeking: ['man'] }
  assert.ok(compatible(ada, bo))
  assert.ok(!compatible(ada, cy))
  assert.ok(score(ada, bo).total > 60)
  assert.deepStrictEqual(score(ada, bo).shared.sort(), ['climbing', 'jazz'])
})

test('replication, matching and messaging across three replicas', async () => {
  const ada = person('ada', { age: 31, gender: 'woman', seeking: 'man', interests: 'climbing,jazz' })
  const bo = person('bo', { age: 33, gender: 'man', seeking: 'woman', interests: 'jazz,tea' })
  const cy = person('cy', { age: 29, gender: 'man', seeking: 'woman', interests: 'chess' })

  // Ada only knows Bo; Bo knows Cy. Ada should still learn about Cy via Bo.
  ada.addPeer(bo.dbDir, 'bo')
  bo.addPeer(ada.dbDir, 'ada')
  bo.addPeer(cy.dbDir, 'cy')
  cy.addPeer(bo.dbDir, 'bo')

  await bo.sync()
  await ada.sync()
  await cy.sync()
  assert.deepStrictEqual(ada.profiles().map((p) => p.name).sort(), ['ada', 'bo', 'cy'])
  assert.deepStrictEqual(ada.discover().candidates.map((x) => x.profile.name), ['bo', 'cy'])

  ada.like(bo.myId)
  ada.like(cy.myId)
  await bo.sync()
  await cy.sync()
  assert.strictEqual(bo.discover().admirers, 1)
  assert.strictEqual(bo.matches().length, 0)

  bo.like(ada.myId)
  assert.strictEqual(bo.matches().length, 1, 'Bo sees the match immediately')
  await ada.sync()
  assert.deepStrictEqual(ada.matches().map((m) => m.profile.name), ['bo'])
  assert.throws(() => ada.message(cy.myId, 'hi'), /matched/)

  ada.message(bo.myId, 'Jazz on Friday?')
  await bo.sync()
  bo.message(ada.myId, 'Yes!')
  await ada.sync()
  assert.deepStrictEqual(ada.matches()[0].messages.map((m) => m.text), ['Jazz on Friday?', 'Yes!'])

  // Cy replicates every sealed box but can read none of Ada and Bo's messages.
  await cy.sync()
  assert.ok(cy.events().every((e) => e.from === cy.myId || e.to === cy.myId))
  assert.ok(fs.readdirSync(path.join(cy.dbDir, 'mail')).length > 6)

  ada.unlike(bo.myId)
  await bo.sync()
  assert.strictEqual(bo.matches().length, 0)
})

test('likes are ordered by sequence number, not by the clock', async () => {
  const ada = person('ada')
  const bo = person('bo')
  await meshSync(ada, bo)
  bo.like(ada.myId)
  ada.like(bo.myId)
  const realNow = Date.now
  try {
    Date.now = () => realNow() - 60 * 60 * 1000 // Ada's clock jumps back an hour
    ada.unlike(bo.myId)
  } finally {
    Date.now = realNow
  }
  assert.strictEqual(ada.isMatch(bo.myId), false)
  await meshSync(ada, bo)
  assert.strictEqual(bo.isMatch(ada.myId), false)
})

test('blocking is private, unlikes, and hides the other person', async () => {
  const ada = person('ada')
  const bo = person('bo')
  await meshSync(ada, bo)
  ada.like(bo.myId)
  bo.like(ada.myId)
  await meshSync(ada, bo)
  assert.ok(ada.isMatch(bo.myId))
  ada.block(bo.myId)
  assert.ok(!ada.isMatch(bo.myId))
  assert.ok(!ada.discover().candidates.some((x) => x.profile.id === bo.myId))
  assert.throws(() => ada.like(bo.myId), /Unblock/)
  await meshSync(ada, bo)
  assert.ok(!bo.isMatch(ada.myId), 'Bo sees an ordinary unmatch')
  assert.ok(!JSON.stringify(fs.readFileSync(path.join(ada.dbDir, 'vault', ada.myId + '.json'), 'utf8')).includes(bo.myId), 'block list is sealed')
})

test('sync rejects forged and tampered profiles', async () => {
  const eve = person('eve')
  const victim = person('victim')
  const honest = new Store(path.join(tmp, 'honest')).init()
  honest.addPeer(eve.dbDir, 'eve')

  // Eve writes the victim's profile under the victim's id, signed by herself...
  const forged = c.sign(eve.identity, { ...victim.me(), name: 'hacked', updated: Date.now() + 1000 })
  fs.writeFileSync(path.join(eve.dbDir, 'profiles', victim.myId + '.json'), JSON.stringify(forged))
  // ...edits her own signed profile without re-signing...
  const ownFile = path.join(eve.dbDir, 'profiles', eve.myId + '.json')
  const own = JSON.parse(fs.readFileSync(ownFile))
  own.payload.age = 17
  fs.writeFileSync(ownFile, JSON.stringify(own))
  // ...and drops junk into the tree.
  fs.writeFileSync(path.join(eve.dbDir, 'mail', 'f'.repeat(64) + '.json'), '{"v":2,"c":"AAAA"}')
  fs.writeFileSync(path.join(eve.dbDir, 'media', 'e'.repeat(64) + '.bin'), 'unvouched')
  fs.writeFileSync(path.join(eve.dbDir, 'evil.sh'), 'rm -rf ~')
  execFileSync('git', ['-c', 'user.name=e', '-c', 'user.email=e@e', 'add', '-A'], { cwd: eve.dbDir })
  execFileSync('git', ['-c', 'user.name=e', '-c', 'user.email=e@e', 'commit', '-qm', 'x'], { cwd: eve.dbDir })

  const s = await honest.sync()
  assert.strictEqual(s.profiles, 0)
  assert.strictEqual(s.rejected, 4)
  assert.strictEqual(honest.profiles().length, 0)
  assert.ok(!fs.existsSync(path.join(honest.dbDir, 'evil.sh')))
})

test('auto-discovered peers must be DHT gittorrent URLs', () => {
  const s = new Store(path.join(tmp, 'disc')).init()
  assert.throws(() => s.saveProfile({ name: 'x', age: 30, gender: 'man', seeking: 'woman', gittorrent: 'ext::sh -c touch /tmp/pwned' }))
  assert.throws(() => s.addPeer('ext::sh -c id'), /unsafe/)
  const ok = s.saveProfile({ name: 'x', age: 30, gender: 'man', seeking: 'woman', gittorrent: 'gittorrent://' + 'a'.repeat(40) + '/datetorrent-db' })
  assert.ok(ok.gittorrent)
})

test('database commits never carry the user\'s git identity', () => {
  const s = person('anon')
  const authors = s.git(['log', '--format=%an <%ae> / %cn <%ce>']).trim().split('\n')
  assert.ok(authors.every((a) => a === 'datetorrent <peer@datetorrent.invalid> / datetorrent <peer@datetorrent.invalid>'), authors.join('\n'))
})
