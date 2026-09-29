'use strict'
// Procedural placeholder "photos" for the demo network: a portrait silhouette
// against bokeh, plus scenes that match someone's interests. Deterministic per
// seed, rendered pixel by pixel and encoded with jpeg-js (a dev dependency).

const jpeg = require('jpeg-js')

const W = 720
const H = 960

function rng (seedText) {
  let a = 0
  for (const ch of String(seedText)) a = (Math.imul(a ^ ch.charCodeAt(0), 2654435761) + 0x9e3779b9) >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const clamp = (v, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v))
const smooth = (e0, e1, x) => { const t = clamp((x - e0) / (e1 - e0)); return t * t * (3 - 2 * t) }
const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]

function hsl (h, s, l) {
  h = ((h % 360) + 360) % 360 / 360
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  const f = (t) => {
    t = (t + 1) % 1
    if (t < 1 / 6) return p + (q - p) * 6 * t
    if (t < 1 / 2) return q
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6
    return p
  }
  return [f(h + 1 / 3) * 255, f(h) * 255, f(h - 1 / 3) * 255]
}

// Scenes return a colour for normalised coordinates (u right, v down).
const SCENES = {
  portrait (r, hue) {
    const top = hsl(hue, 0.55, 0.62)
    const bottom = hsl(hue + 40, 0.5, 0.3)
    const bokeh = Array.from({ length: 22 }, () => ({ x: r(), y: r() * 0.8, rad: 0.03 + r() * 0.07, c: hsl(hue + r() * 80 - 40, 0.8, 0.75), a: 0.15 + r() * 0.3 }))
    const skin = hsl(18 + r() * 22, 0.4, 0.22 + r() * 0.35)
    const hair = hsl(20 + r() * 20, 0.3, 0.06 + r() * 0.2)
    const shirt = hsl(hue + 150 + r() * 90, 0.35, 0.25)
    const headY = 0.37 + r() * 0.03
    const hairLong = r() > 0.5
    return (u, v) => {
      let c = mix(top, bottom, v)
      for (const b of bokeh) {
        const d = Math.hypot((u - b.x) * 0.75, v - b.y)
        const k = (1 - smooth(b.rad * 0.85, b.rad, d)) * b.a
        c = mix(c, b.c, k)
      }
      // Hair behind the head, then face, neck and shoulders, with a rim light.
      const hairD = hairLong
        ? Math.hypot((u - 0.5) / 0.175, (v - headY - 0.06) / 0.25)
        : Math.hypot((u - 0.5) / 0.15, (v - headY + 0.02) / 0.165)
      c = mix(c, hair, 1 - smooth(0.97, 1.0, hairD))
      const head = Math.hypot((u - 0.5) / 0.13, (v - headY) / 0.155)
      const face = (1 - smooth(0.97, 1.0, head)) * smooth(headY - 0.075, headY - 0.055, v)
      const inNeck = Math.abs(u - 0.5) < 0.062 && v > headY && v < 0.66 ? 1 : 0
      const shoulders = Math.hypot((u - 0.5) / 0.42, (v - 0.94) / 0.33)
      const inBody = 1 - smooth(0.98, 1.0, shoulders)
      c = mix(c, mix(skin, [0, 0, 0], 0.15), inNeck)
      c = mix(c, skin, face)
      c = mix(c, shirt, inBody)
      const rim = (smooth(0.86, 0.97, head) * face + smooth(0.9, 0.98, shoulders) * inBody) * clamp((u - 0.5) * 3 + 0.4)
      return mix(c, top, rim * 0.6)
    }
  },
  mountains (r, hue) {
    const sky0 = hsl(210 + (hue % 40), 0.5, 0.72)
    const sky1 = hsl(20 + (hue % 30), 0.8, 0.72)
    const sun = { x: 0.3 + r() * 0.4, y: 0.35 + r() * 0.1 }
    const ridges = [0, 1, 2, 3].map((i) => ({ base: 0.5 + i * 0.12, amp: 0.12 - i * 0.02, f: 3 + r() * 4 + i, ph: r() * 6, c: hsl(230 + (hue % 60) - i * 10, 0.25, 0.45 - i * 0.1) }))
    return (u, v) => {
      let c = mix(sky0, sky1, smooth(0, 0.6, v))
      c = mix(c, [255, 240, 210], 1 - smooth(0.06, 0.075, Math.hypot(u - sun.x, (v - sun.y) * 1.33)))
      c = mix(c, [255, 220, 170], 0.35 * (1 - smooth(0, 0.35, Math.hypot(u - sun.x, v - sun.y))))
      for (const rg of ridges) {
        const edge = rg.base - rg.amp * (0.6 * Math.sin(u * rg.f + rg.ph) + 0.4 * Math.sin(u * rg.f * 2.7 + rg.ph * 2))
        c = mix(c, rg.c, smooth(edge - 0.003, edge + 0.003, v))
      }
      return c
    }
  },
  sea (r, hue) {
    const sky0 = hsl(200 + (hue % 30), 0.6, 0.72)
    const sky1 = hsl(25 + (hue % 30), 0.75, 0.82)
    const water = hsl(205, 0.55, 0.35)
    const horizon = 0.55
    const boat = { x: 0.35 + r() * 0.3 }
    return (u, v) => {
      let c = v < horizon ? mix(sky0, sky1, v / horizon) : mix(mix(sky1, water, 0.6), water, smooth(horizon, 1, v))
      if (v > horizon) c = mix(c, [255, 255, 255], 0.18 * Math.max(0, Math.sin((v - horizon) * 180 / (v - horizon + 0.05) + u * 9)))
      const bx = u - boat.x
      const sail = v < horizon - 0.005 && v > horizon - 0.2 && bx > 0 && bx < (v - (horizon - 0.2)) * 0.5
      const hull = v > horizon - 0.01 && v < horizon + 0.015 && Math.abs(bx - 0.04) < 0.08 - (v - horizon + 0.01) * 2
      if (sail) c = [250, 248, 240]
      if (hull) c = [60, 45, 40]
      return c
    }
  },
  city (r, hue) {
    const sky0 = hsl(235, 0.5, 0.1)
    const sky1 = hsl(280 + (hue % 50), 0.45, 0.3)
    const towers = Array.from({ length: 11 }, (_, i) => ({ x0: i / 11 - 0.02, w: 0.07 + r() * 0.04, top: 0.35 + r() * 0.35 }))
    const bokeh = Array.from({ length: 18 }, () => ({ x: r(), y: 0.1 + r() * 0.5, rad: 0.02 + r() * 0.05, c: hsl(hue + r() * 120, 0.9, 0.65) }))
    return (u, v) => {
      let c = mix(sky0, sky1, v)
      for (const t of towers) {
        if (u > t.x0 && u < t.x0 + t.w && v > t.top) {
          c = [18, 16, 30]
          const wx = ((u - t.x0) * 90) % 1
          const wy = ((v - t.top) * 70) % 1
          const lit = Math.sin(Math.floor((u - t.x0) * 90) * 12.9 + Math.floor((v - t.top) * 70) * 78.2) > 0.3
          if (lit && wx > 0.3 && wx < 0.8 && wy > 0.3 && wy < 0.8) c = [255, 205, 120]
        }
      }
      for (const b of bokeh) c = mix(c, b.c, (1 - smooth(b.rad * 0.8, b.rad, Math.hypot((u - b.x) * 0.75, v - b.y))) * 0.35)
      return c
    }
  },
  warm (r, hue) {
    const bg0 = hsl(25 + r() * 15, 0.55, 0.3)
    const bg1 = hsl(10, 0.5, 0.12)
    const loaf = { x: 0.5, y: 0.62 }
    const bokeh = Array.from({ length: 16 }, () => ({ x: r(), y: r() * 0.45, rad: 0.03 + r() * 0.06 }))
    return (u, v) => {
      let c = mix(bg0, bg1, v)
      for (const b of bokeh) c = mix(c, [255, 200, 130], (1 - smooth(b.rad * 0.8, b.rad, Math.hypot((u - b.x) * 0.75, v - b.y))) * 0.4)
      if (v > 0.72) c = mix([110, 78, 55], [70, 48, 35], (v - 0.72) * 3)
      const d = Math.hypot((u - loaf.x) / 0.3, (v - loaf.y) / 0.14)
      if (d < 1 && v < 0.74) {
        c = mix([214, 150, 80], [150, 90, 40], smooth(0.3, 1, d))
        if (Math.abs(Math.sin((u - loaf.x) * 30 + (v - loaf.y) * 18)) < 0.12 && d < 0.8) c = [240, 210, 160]
      }
      return c
    }
  }
}

const THEMES = [
  [/climb|hik|cycl/, 'mountains'],
  [/sail|surf|swim/, 'sea'],
  [/jazz|synth|film|board|poetry/, 'city'],
  [/sourdough|cook|tea|bread/, 'warm']
]

function sceneFor (interest) {
  for (const [re, scene] of THEMES) if (re.test(interest)) return scene
  return 'mountains'
}

function generatePhoto (seed, scene, hue) {
  const r = rng(seed)
  const shade = SCENES[scene](r, hue)
  const data = Buffer.alloc(W * H * 4)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const c = shade(x / W, y / H)
      const grain = (r() - 0.5) * 10
      const vignette = 1 - 0.35 * smooth(0.35, 0.95, Math.hypot(x / W - 0.5, y / H - 0.5))
      const i = (y * W + x) * 4
      data[i] = clamp((c[0] + grain) * vignette, 0, 255)
      data[i + 1] = clamp((c[1] + grain) * vignette, 0, 255)
      data[i + 2] = clamp((c[2] + grain) * vignette, 0, 255)
      data[i + 3] = 255
    }
  }
  return jpeg.encode({ data, width: W, height: H }, 82).data
}

// A portrait plus one scene per interest (up to `count` photos).
function photosFor (name, interests, count = 3) {
  const hue = rng(name + ':hue')() * 360
  const scenes = ['portrait', ...interests.map(sceneFor)]
  return [...new Set(scenes)].slice(0, count).map((scene, i) => generatePhoto(`${name}:${i}`, scene, hue))
}

module.exports = { generatePhoto, photosFor }
