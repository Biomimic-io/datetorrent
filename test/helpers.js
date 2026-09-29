'use strict'
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { Store } = require('../lib/store')

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'datetorrent-test-'))
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }))

let counter = 0
function person (name, fields = {}) {
  const s = new Store(path.join(tmp, `${name}-${++counter}`)).init()
  s.saveProfile({ name, age: 30, gender: 'woman', seeking: 'man,woman', ageMin: 20, ageMax: 60, region: 'Portland, OR', ...fields })
  return s
}

// Everyone pulls from everyone else, the way gossip eventually converges.
async function meshSync (...stores) {
  for (const a of stores) for (const b of stores) if (a !== b) a.addPeer(b.dbDir, 'p-' + b.myId.slice(0, 8))
  for (let i = 0; i < 2; i++) for (const s of stores) await s.sync()
}

// A structurally valid JPEG (segments only; nothing decodes the pixels) with
// an EXIF block carrying fake GPS text, so tests can check it gets stripped.
function fakeJpeg (label = 'photo') {
  const seg = (marker, body) => {
    const len = Buffer.alloc(2)
    len.writeUInt16BE(body.length + 2)
    return Buffer.concat([Buffer.from([0xff, marker]), len, body])
  }
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    seg(0xe0, Buffer.from('JFIF\0\x01\x01\0\0\x01\0\x01\0\0', 'latin1')),
    seg(0xe1, Buffer.from('Exif\0\0GPSLatitude=45.5231 GPSLongitude=-122.6765', 'latin1')),
    seg(0xfe, Buffer.from('comment: taken at home', 'latin1')),
    seg(0xdb, Buffer.alloc(65, 1)),
    Buffer.from([0xff, 0xda, 0x00, 0x08, 1, 2, 3, 4, 5, 6]),
    Buffer.from(label + ':' + Math.random()),
    Buffer.from([0xff, 0xd9])
  ])
}

module.exports = { tmp, person, meshSync, fakeJpeg }
