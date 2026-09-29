'use strict'
// Removes metadata from a JPEG before it is encrypted: EXIF (GPS, camera
// serial, timestamps), XMP, IPTC, comments and every other APPn block except
// the JFIF header and an embedded colour profile. The image data is untouched.
//
// The web UI already re-encodes photos through a <canvas>, which drops
// metadata and bakes in rotation; this is the second line of defence and the
// only one for photos added from the CLI.

const MAX_PHOTO_BYTES = 1.5 * 1024 * 1024

const isJpeg = (buf) => buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8

function stripJpegMetadata (buf) {
  if (!isJpeg(buf)) throw new Error('Photos must be JPEG images')
  const out = [buf.subarray(0, 2)]
  let i = 2
  while (i + 4 <= buf.length) {
    if (buf[i] !== 0xff) throw new Error('Corrupt JPEG')
    const marker = buf[i + 1]
    if (marker === 0xff) { i++; continue } // fill byte
    if (marker === 0xda) { out.push(buf.subarray(i)); return Buffer.concat(out) } // start of scan: rest is image data
    if (marker === 0xd9) break // end of image
    const len = buf.readUInt16BE(i + 2)
    const seg = buf.subarray(i, i + 2 + len)
    if (seg.length !== 2 + len) throw new Error('Corrupt JPEG')
    const isApp = marker >= 0xe0 && marker <= 0xef
    const keep = !isApp && marker !== 0xfe
      ? true
      : marker === 0xe0 || (marker === 0xe2 && seg.subarray(4, 16).toString('latin1') === 'ICC_PROFILE\0')
    if (keep) out.push(seg)
    i += 2 + len
  }
  throw new Error('Corrupt JPEG: no image data')
}

function preparePhoto (buf) {
  const clean = stripJpegMetadata(Buffer.from(buf))
  if (clean.length > MAX_PHOTO_BYTES) throw new Error(`Photo is ${(clean.length / 1048576).toFixed(1)} MB; the limit is 1.5 MB. Add it through the web app, which resizes automatically.`)
  return clean
}

module.exports = { preparePhoto, stripJpegMetadata, MAX_PHOTO_BYTES }
