// Discover as a 3D card stack (three.js). Drag or use the buttons to like or
// pass; tap the sides of a card to flip through photos, tap the middle to
// turn it over for a full-profile preview. Throws if WebGL is unavailable so
// the caller can fall back to the plain grid.

import * as THREE from '/vendor/three/three.module.js'

const CARD_W = 3.15
const CARD_H = 4.2
const TEX_W = 768
const TEX_H = 1024
const STACK = 3
const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif'
const ACCENT = '#e11d48'
const LIKE = '#1faa59'

export function mountDiscover (host, { candidates, photoUrl, onDecision, onEmpty, onFocus, icon }) {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches
  const K = reduced ? 420 : 190 // spring stiffness
  const C = reduced ? 42 : 20 // damping

  // ------------------------------------------------------------ DOM shell
  const stage = document.createElement('div')
  stage.className = 'stage'
  const canvas = document.createElement('canvas')
  canvas.setAttribute('aria-hidden', 'true')
  stage.append(canvas)
  const live = document.createElement('p')
  live.className = 'sr-only'
  live.setAttribute('aria-live', 'polite')
  const controls = document.createElement('div')
  controls.className = 'swipe-controls'
  const mkBtn = (cls, label, glyph, fallback) => {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'round ' + cls
    b.setAttribute('aria-label', label)
    b.title = label
    if (icon) b.append(icon(glyph)); else b.textContent = fallback
    return b
  }
  const passBtn = mkBtn('pass', 'Pass (left arrow)', 'close', '✕')
  const infoBtn = mkBtn('info', 'Preview profile (space)', 'info', 'i')
  const likeBtn = mkBtn('like', 'Like (right arrow)', 'heart', '♥')
  infoBtn.setAttribute('aria-pressed', 'false')
  controls.append(passBtn, infoBtn, likeBtn)
  const hint = document.createElement('p')
  hint.className = 'swipe-hint'
  hint.textContent = 'Drag or use ← → to decide · tap a card’s sides for more photos · tap the middle or press space to see their profile'
  host.append(stage, controls, hint, live)

  // ---------------------------------------------------------------- three
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true })
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
  renderer.outputColorSpace = THREE.SRGBColorSpace
  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 100)
  const maxAniso = renderer.capabilities.getMaxAnisotropy()

  const cardGeo = roundedRect(CARD_W, CARD_H, 0.22)
  const shadow = new THREE.Mesh(new THREE.PlaneGeometry(CARD_W * 1.9, CARD_H * 1.5), new THREE.MeshBasicMaterial({
    map: radialTexture('rgba(0,0,0,0.45)'), transparent: true, depthWrite: false
  }))
  shadow.position.set(0, -0.35, -1.2)
  scene.add(shadow)

  // Drifting background motes, and a burst of hearts for matches.
  const motes = makeMotes(reduced ? 0 : 160)
  scene.add(motes.points)
  const burst = makeBurst()
  scene.add(burst.points)

  // ---------------------------------------------------------------- cards
  const images = new Map() // obj -> HTMLImageElement (loaded)
  const queue = candidates.slice()
  const cards = [] // index 0 is the top card
  const flying = new Set() // decided cards animating off-screen
  let preview = false
  let busy = false

  function loadImage (ownerId, obj, onLoad) {
    if (images.has(obj)) return images.get(obj)
    const img = new Image()
    img.decoding = 'async'
    img.onload = () => { images.set(obj, img); onLoad() }
    img.src = photoUrl(ownerId, obj)
    return null
  }

  function buildCard (c) {
    const p = c.profile
    const group = new THREE.Group()
    const front = makeCanvasTexture()
    const back = makeCanvasTexture()
    const frontMesh = new THREE.Mesh(cardGeo, new THREE.MeshBasicMaterial({ map: front.texture }))
    const backMesh = new THREE.Mesh(cardGeo, new THREE.MeshBasicMaterial({ map: back.texture }))
    backMesh.rotation.y = Math.PI
    const likeStamp = stampMesh('LIKE', LIKE, -0.78, 0.26)
    const nopeStamp = stampMesh('NOPE', ACCENT, 0.78, -0.26)
    group.add(frontMesh, backMesh, likeStamp, nopeStamp)
    const card = {
      c, group, front, back, frontMesh, likeStamp, nopeStamp,
      photo: 0,
      cur: [0, -2.5, -3, 0, 0, 0, 0.6], // x y z rx ry rz scale: new cards rise into place
      vel: [0, 0, 0, 0, 0, 0, 0],
      tgt: [0, 0, 0, 0, 0, 0, 1],
      leaving: false,
      redraw () {
        drawFront(front.ctx, c, images.get(p.photos[this.photo]), this.photo)
        front.texture.needsUpdate = true
        drawBack(back.ctx, c, p.photos.map((o) => images.get(o)).filter(Boolean))
        back.texture.needsUpdate = true
      }
    }
    for (const obj of p.photos) loadImage(p.id, obj, () => card.redraw())
    card.redraw()
    scene.add(group)
    return card
  }

  function fillStack () {
    while (cards.length < STACK && queue.length) cards.push(buildCard(queue.shift()))
    layout()
    announce()
    if (!cards.length) onEmpty()
  }

  function layout () {
    cards.forEach((card, d) => {
      if (card.leaving) return
      const top = d === 0
      card.tgt = [0, -0.3 * d, -0.45 * d, 0, top && preview ? Math.PI : 0, 0, 1 - 0.04 * d]
      if (top && preview) { card.tgt[1] = -0.05; card.tgt[2] = 0.25 }
      card.group.renderOrder = STACK - d
    })
  }

  function announce () {
    const top = cards[0]
    if (!top) { live.textContent = 'No more profiles.'; return }
    const p = top.c.profile
    live.textContent = `${p.name}, ${p.age}, ${p.region || ''}. ${top.c.score}% compatible. ${p.bio || ''}`
    onFocus?.(p)
  }

  async function decide (dir) {
    const card = cards[0]
    if (!card || busy) return
    busy = true
    preview = false
    card.leaving = true
    const s = dir === 'like' ? 1 : -1
    card.tgt = [s * 9, card.cur[1] + 0.8, 0.5, 0, 0, -s * 0.7, 1]
    card.vel[0] += s * 12
    ;(dir === 'like' ? card.likeStamp : card.nopeStamp).material.opacity = 1
    cards.shift()
    flying.add(card)
    setTimeout(() => { flying.delete(card); dispose(card) }, 900)
    fillStack()
    busy = false
    try {
      const matched = await onDecision(card.c.profile, dir, card.c)
      if (matched && !reduced) burst.fire()
    } catch {}
  }

  // Undo a pass: the card flies back in from the left, on top of the stack.
  function restore (c) {
    const card = buildCard(c)
    card.cur = [-8, 0.8, 0.5, 0, 0, 0.7, 1]
    cards.unshift(card)
    while (cards.length > STACK) {
      const extra = cards.pop()
      queue.unshift(extra.c)
      dispose(extra)
    }
    preview = false
    layout()
    announce()
  }

  function togglePreview (force) {
    if (!cards[0]) return
    preview = force ?? !preview
    infoBtn.setAttribute('aria-pressed', String(preview))
    layout()
  }

  function nextPhoto (step) {
    const card = cards[0]
    const n = card?.c.profile.photos.length || 0
    if (n < 2) { if (card) card.vel[4] += step * 1.2; return } // a little shake: nothing more to see
    card.photo = (card.photo + step + n) % n
    card.redraw()
  }

  function dispose (card) {
    scene.remove(card.group)
    card.front.texture.dispose()
    card.back.texture.dispose()
    card.group.traverse((o) => { if (o.material && o !== card.frontMesh) o.material.dispose?.() })
    card.frontMesh.material.dispose()
  }

  // ------------------------------------------------------------ pointer
  const raycaster = new THREE.Raycaster()
  const ndc = new THREE.Vector2()
  let drag = null
  let hover = { x: 0, y: 0 }

  function worldPerPixel () {
    const h = 2 * camera.position.z * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))
    return h / canvas.clientHeight
  }

  function onDown (e) {
    if (!cards[0] || e.button > 0) return
    canvas.setPointerCapture(e.pointerId)
    drag = { id: e.pointerId, x0: e.clientX, y0: e.clientY, t0: performance.now(), lastX: e.clientX, lastT: performance.now(), vx: 0, moved: 0 }
  }

  function onMove (e) {
    const r = canvas.getBoundingClientRect()
    hover = { x: ((e.clientX - r.left) / r.width) * 2 - 1, y: ((e.clientY - r.top) / r.height) * 2 - 1 }
    if (!drag || e.pointerId !== drag.id) return
    const card = cards[0]
    if (!card) return
    const wpp = worldPerPixel()
    const dx = e.clientX - drag.x0
    const dy = e.clientY - drag.y0
    drag.moved = Math.max(drag.moved, Math.hypot(dx, dy))
    const now = performance.now()
    drag.vx = 0.8 * drag.vx + 0.2 * ((e.clientX - drag.lastX) / Math.max(1, now - drag.lastT))
    drag.lastX = e.clientX
    drag.lastT = now
    if (drag.moved < 6) return
    if (preview) togglePreview(false)
    card.cur[0] = dx * wpp
    card.cur[1] = -dy * wpp * 0.45
    card.cur[5] = -card.cur[0] * 0.12
    card.vel.fill(0)
  }

  function onUp (e) {
    if (!drag || e.pointerId !== drag.id) return
    const d = drag
    drag = null
    const card = cards[0]
    if (!card) return
    if (d.moved < 6 && performance.now() - d.t0 < 400) return onTap(e)
    const x = card.cur[0]
    const fling = Math.abs(d.vx) > 0.9 // px per ms
    if (Math.abs(x) > 1.35 || (fling && Math.sign(d.vx) === Math.sign(x))) decide(x > 0 ? 'like' : 'pass')
  }

  function onTap (e) {
    const card = cards[0]
    const r = canvas.getBoundingClientRect()
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1)
    raycaster.setFromCamera(ndc, camera)
    const hit = raycaster.intersectObject(card.group, true)[0]
    if (!hit) return
    if (preview) return togglePreview(false)
    const u = hit.uv ? hit.uv.x : 0.5
    if (u < 0.3) nextPhoto(-1)
    else if (u > 0.7) nextPhoto(1)
    else togglePreview(true)
  }

  function onKey (e) {
    if (e.target.closest?.('input, textarea, select')) return
    if (e.key === 'ArrowRight') { e.preventDefault(); decide('like') }
    if (e.key === 'ArrowLeft') { e.preventDefault(); decide('pass') }
    if (e.key === ' ' || e.key === 'ArrowUp') { e.preventDefault(); togglePreview() }
    if (e.key === 'ArrowDown' && preview) { e.preventDefault(); togglePreview(false) }
  }

  canvas.addEventListener('pointerdown', onDown)
  canvas.addEventListener('pointermove', onMove)
  canvas.addEventListener('pointerup', onUp)
  canvas.addEventListener('pointercancel', onUp)
  canvas.addEventListener('pointerleave', () => { hover = { x: 0, y: 0 } })
  window.addEventListener('keydown', onKey)
  passBtn.onclick = () => decide('pass')
  likeBtn.onclick = () => decide('like')
  infoBtn.onclick = () => togglePreview()

  // ------------------------------------------------------------- sizing
  function resize () {
    const w = stage.clientWidth
    const h = stage.clientHeight
    if (!w || !h) return
    renderer.setSize(w, h, false)
    camera.aspect = w / h
    const tan = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))
    // Fit the card with room for the stack below and a swipe margin at the sides.
    const byHeight = (CARD_H * 1.22) / (2 * tan)
    const byWidth = (CARD_W * 1.3) / (2 * tan * camera.aspect)
    camera.position.set(0, -0.25, Math.max(byHeight, byWidth))
    camera.updateProjectionMatrix()
  }
  const ro = new ResizeObserver(resize)
  ro.observe(stage)
  resize()

  // --------------------------------------------------------------- loop
  // Damped springs on x y z rx ry rz scale. While dragging, the pointer owns
  // x, y and the z tilt.
  function step (card, dt, dragging) {
    for (let i = 0; i < 7; i++) {
      if (dragging && (i === 0 || i === 1 || i === 5)) continue
      const a = K * (card.tgt[i] - card.cur[i]) - C * card.vel[i]
      card.vel[i] += a * dt
      card.cur[i] += card.vel[i] * dt
    }
    const [x, y, z, rx, ry, rz, sc] = card.cur
    card.group.position.set(x, y, z)
    card.group.rotation.set(rx, ry, rz)
    card.group.scale.setScalar(sc)
  }

  let raf = 0
  let last = performance.now()
  function frame (now) {
    raf = requestAnimationFrame(frame)
    const dt = Math.min(0.033, (now - last) / 1000)
    last = now
    const t = now / 1000
    for (const card of flying) step(card, dt, false)
    cards.forEach((card, d) => {
      const dragging = d === 0 && drag && drag.moved >= 6
      if (d === 0 && !dragging && !card.leaving && !preview && !reduced) {
        // Idle: lean toward the pointer, and breathe a little.
        card.tgt[3] = hover.y * 0.12
        card.tgt[4] = hover.x * 0.16
        card.tgt[1] = Math.sin(t * 1.4) * 0.03
      }
      step(card, dt, dragging)
      if (d === 0) {
        card.likeStamp.material.opacity = THREE.MathUtils.clamp(card.cur[0] / 1.3, 0, 1)
        card.nopeStamp.material.opacity = THREE.MathUtils.clamp(-card.cur[0] / 1.3, 0, 1)
      }
    })
    const top = cards[0]
    shadow.position.x = top ? top.cur[0] * 0.4 : 0
    shadow.material.opacity = top ? 1 - Math.min(0.7, Math.abs(top.cur[0]) / 6) : 0.3
    motes.tick(dt)
    burst.tick(dt)
    renderer.render(scene, camera)
  }
  fillStack()
  raf = requestAnimationFrame(frame)
  host.__debug = { camera, cards, renderer } // for devtools

  return {
    restore,
    like: () => decide('like'),
    pass: () => decide('pass'),
    destroy () {
      cancelAnimationFrame(raf)
      ro.disconnect()
      window.removeEventListener('keydown', onKey)
      for (const card of [...cards, ...flying]) dispose(card)
      renderer.dispose()
      host.replaceChildren()
    }
  }
}

// ------------------------------------------------------------- helpers

function roundedRect (w, h, r) {
  const x = -w / 2
  const y = -h / 2
  const s = new THREE.Shape()
  s.moveTo(x + r, y)
  s.lineTo(x + w - r, y)
  s.quadraticCurveTo(x + w, y, x + w, y + r)
  s.lineTo(x + w, y + h - r)
  s.quadraticCurveTo(x + w, y + h, x + w - r, y + h)
  s.lineTo(x + r, y + h)
  s.quadraticCurveTo(x, y + h, x, y + h - r)
  s.lineTo(x, y + r)
  s.quadraticCurveTo(x, y, x + r, y)
  const g = new THREE.ShapeGeometry(s, 10)
  const pos = g.attributes.position
  const uv = g.attributes.uv
  for (let i = 0; i < pos.count; i++) uv.setXY(i, (pos.getX(i) - x) / w, (pos.getY(i) - y) / h)
  return g
}

function makeCanvasTexture () {
  const canvas = document.createElement('canvas')
  canvas.width = TEX_W
  canvas.height = TEX_H
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.anisotropy = 8
  return { canvas, ctx: canvas.getContext('2d'), texture }
}

function radialTexture (inner) {
  const c = document.createElement('canvas')
  c.width = c.height = 256
  const g = c.getContext('2d')
  const grad = g.createRadialGradient(128, 128, 10, 128, 128, 128)
  grad.addColorStop(0, inner)
  grad.addColorStop(1, 'rgba(0,0,0,0)')
  g.fillStyle = grad
  g.fillRect(0, 0, 256, 256)
  return new THREE.CanvasTexture(c)
}

function stampMesh (text, color, x, rot) {
  const c = document.createElement('canvas')
  c.width = 420
  c.height = 170
  const g = c.getContext('2d')
  g.strokeStyle = color
  g.lineWidth = 12
  roundRectPath(g, 10, 10, 400, 150, 22)
  g.stroke()
  g.fillStyle = color
  g.font = `900 104px ${FONT}`
  g.textAlign = 'center'
  g.textBaseline = 'middle'
  g.fillText(text, 210, 92)
  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  const m = new THREE.Mesh(new THREE.PlaneGeometry(1.35, 0.55), new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: 0, depthWrite: false }))
  m.position.set(x, 1.45, 0.02)
  m.rotation.z = rot
  return m
}

function roundRectPath (g, x, y, w, h, r) {
  g.beginPath()
  g.moveTo(x + r, y)
  g.arcTo(x + w, y, x + w, y + h, r)
  g.arcTo(x + w, y + h, x, y + h, r)
  g.arcTo(x, y + h, x, y, r)
  g.arcTo(x, y, x + w, y, r)
  g.closePath()
}

function hueOf (id) { return parseInt(id.slice(0, 6), 16) % 360 }

function cover (g, img, x, y, w, h) {
  const s = Math.max(w / img.width, h / img.height)
  const iw = img.width * s
  const ih = img.height * s
  g.drawImage(img, x + (w - iw) / 2, y + (h - ih) / 2, iw, ih)
}

function wrap (g, text, x, y, maxW, lineH, maxLines) {
  const words = String(text).split(/\s+/)
  let line = ''
  let lines = 0
  for (let i = 0; i < words.length; i++) {
    const test = line ? line + ' ' + words[i] : words[i]
    if (g.measureText(test).width > maxW && line) {
      if (++lines === maxLines) { g.fillText(line.replace(/\W*$/, '') + '…', x, y); return y + lineH }
      g.fillText(line, x, y)
      y += lineH
      line = words[i]
    } else line = test
  }
  if (line) { g.fillText(line, x, y); y += lineH }
  return y
}

function chips (g, items, shared, x, y, maxW, size = 30) {
  g.font = `600 ${size}px ${FONT}`
  let cx = x
  for (const it of items) {
    const w = g.measureText(it).width + size * 1.1
    if (cx + w > x + maxW) { cx = x; y += size * 1.75 }
    g.fillStyle = shared.has(it) ? ACCENT : 'rgba(255,255,255,0.18)'
    roundRectPath(g, cx, y, w, size * 1.45, size * 0.72)
    g.fill()
    g.fillStyle = '#fff'
    g.textBaseline = 'middle'
    g.fillText(it, cx + size * 0.55, y + size * 0.74)
    g.textBaseline = 'alphabetic'
    cx += w + 12
  }
  return y + size * 1.75
}

function drawFront (g, c, img, photoIndex) {
  const p = c.profile
  const hue = hueOf(p.id)
  g.clearRect(0, 0, TEX_W, TEX_H)
  if (img) cover(g, img, 0, 0, TEX_W, TEX_H)
  else {
    const bg = g.createLinearGradient(0, 0, TEX_W, TEX_H)
    bg.addColorStop(0, `hsl(${hue} 60% 55%)`)
    bg.addColorStop(1, `hsl(${hue + 50} 55% 30%)`)
    g.fillStyle = bg
    g.fillRect(0, 0, TEX_W, TEX_H)
    g.fillStyle = 'rgba(255,255,255,0.9)'
    g.font = `800 300px ${FONT}`
    g.textAlign = 'center'
    g.fillText(p.name[0].toUpperCase(), TEX_W / 2, TEX_H * 0.5)
    g.textAlign = 'left'
  }
  const topShade = g.createLinearGradient(0, 0, 0, 160)
  topShade.addColorStop(0, 'rgba(0,0,0,0.45)')
  topShade.addColorStop(1, 'rgba(0,0,0,0)')
  g.fillStyle = topShade
  g.fillRect(0, 0, TEX_W, 160)
  const shade = g.createLinearGradient(0, TEX_H * 0.45, 0, TEX_H)
  shade.addColorStop(0, 'rgba(0,0,0,0)')
  shade.addColorStop(1, 'rgba(0,0,0,0.88)')
  g.fillStyle = shade
  g.fillRect(0, TEX_H * 0.45, TEX_W, TEX_H * 0.55)

  // Photo position bars.
  const n = Math.max(1, p.photos.length)
  const gap = 10
  const bw = (TEX_W - 60 - gap * (n - 1)) / n
  for (let i = 0; i < n; i++) {
    g.fillStyle = i === photoIndex ? 'rgba(255,255,255,0.95)' : 'rgba(255,255,255,0.35)'
    roundRectPath(g, 30 + i * (bw + gap), 22, bw, 8, 4)
    g.fill()
  }

  // Match score pill.
  g.font = `800 34px ${FONT}`
  const label = `${c.score}% match`
  const lw = g.measureText(label).width + 40
  g.fillStyle = 'rgba(0,0,0,0.45)'
  roundRectPath(g, TEX_W - lw - 30, 52, lw, 56, 28)
  g.fill()
  g.fillStyle = '#fff'
  g.fillText(label, TEX_W - lw - 10, 92)

  const shared = new Set(c.shared)
  let y = TEX_H - 250
  g.fillStyle = '#fff'
  g.font = `800 66px ${FONT}`
  g.fillText(`${p.name}, ${p.age}`, 40, y)
  y += 50
  g.font = `500 32px ${FONT}`
  g.fillStyle = 'rgba(255,255,255,0.85)'
  g.fillText(`${p.gender} · ${p.region || 'somewhere'}`, 40, y)
  y += 36
  const list = [...p.interests].sort((a, b) => shared.has(b) - shared.has(a)).slice(0, 5)
  chips(g, list, shared, 40, y, TEX_W - 80)
}

function drawBack (g, c, imgs) {
  const p = c.profile
  const hue = hueOf(p.id)
  const bg = g.createLinearGradient(0, 0, 0, TEX_H)
  bg.addColorStop(0, `hsl(${hue} 25% 16%)`)
  bg.addColorStop(1, '#141110')
  g.fillStyle = bg
  g.fillRect(0, 0, TEX_W, TEX_H)
  const pad = 44
  let y = 96
  g.fillStyle = '#fff'
  g.font = `800 60px ${FONT}`
  g.fillText(`${p.name}, ${p.age}`, pad, y)
  y += 46
  g.font = `500 30px ${FONT}`
  g.fillStyle = 'rgba(255,255,255,0.7)'
  g.fillText(`${p.gender} · ${p.region || 'somewhere'}`, pad, y)
  y += 60

  g.fillStyle = ACCENT
  g.font = `800 40px ${FONT}`
  g.fillText(`${c.score}% compatible`, pad, y)
  if (c.shared.length) {
    g.font = `500 28px ${FONT}`
    g.fillStyle = 'rgba(255,255,255,0.75)'
    g.fillText(`You both like ${c.shared.join(', ')}`, pad, y + 40)
    y += 40
  }
  y += 64

  if (p.bio) {
    g.fillStyle = '#fff'
    g.font = `400 34px ${FONT}`
    y = wrap(g, p.bio, pad, y, TEX_W - pad * 2, 46, 5) + 18
  }
  y = chips(g, p.interests, new Set(c.shared), pad, y, TEX_W - pad * 2, 28) + 30
  g.fillStyle = 'rgba(255,255,255,0.6)'
  g.font = `500 28px ${FONT}`
  g.fillText(`Looking for ${p.seeking.join(', ')} · ${p.ageMin}–${p.ageMax}`, pad, y + 10)
  y += 50

  // Photo strip: the preview's gallery.
  const n = imgs.length
  if (n) {
    const size = Math.min(210, (TEX_W - pad * 2 - 16 * (n - 1)) / n)
    const ty = Math.max(y + 10, TEX_H - size - 70)
    imgs.forEach((img, i) => {
      g.save()
      roundRectPath(g, pad + i * (size + 16), ty, size, size, 18)
      g.clip()
      cover(g, img, pad + i * (size + 16), ty, size, size)
      g.restore()
    })
  }
  g.fillStyle = 'rgba(255,255,255,0.45)'
  g.font = `500 24px ${FONT}`
  g.fillText('Tap to turn back', pad, TEX_H - 30)
}

function makeMotes (count) {
  const geo = new THREE.BufferGeometry()
  const pos = new Float32Array(count * 3)
  const speed = new Float32Array(count)
  for (let i = 0; i < count; i++) {
    pos[i * 3] = (Math.random() - 0.5) * 16
    pos[i * 3 + 1] = (Math.random() - 0.5) * 10
    pos[i * 3 + 2] = -3 - Math.random() * 6
    speed[i] = 0.1 + Math.random() * 0.35
  }
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  const points = new THREE.Points(geo, new THREE.PointsMaterial({
    color: 0xff7a7e, size: 0.07, transparent: true, opacity: 0.55, depthWrite: false, map: radialTexture('rgba(255,255,255,1)')
  }))
  return {
    points,
    tick (dt) {
      for (let i = 0; i < count; i++) {
        pos[i * 3 + 1] += speed[i] * dt
        pos[i * 3] += Math.sin(pos[i * 3 + 1] + i) * 0.02 * dt
        if (pos[i * 3 + 1] > 5) pos[i * 3 + 1] = -5
      }
      if (count) geo.attributes.position.needsUpdate = true
    }
  }
}

function heartTexture () {
  const c = document.createElement('canvas')
  c.width = c.height = 128
  const g = c.getContext('2d')
  g.fillStyle = '#fff'
  g.beginPath()
  g.moveTo(64, 112)
  g.bezierCurveTo(10, 72, 4, 36, 34, 22)
  g.bezierCurveTo(52, 14, 64, 28, 64, 38)
  g.bezierCurveTo(64, 28, 76, 14, 94, 22)
  g.bezierCurveTo(124, 36, 118, 72, 64, 112)
  g.fill()
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  return t
}

function makeBurst () {
  const count = 90
  const geo = new THREE.BufferGeometry()
  const pos = new Float32Array(count * 3)
  const vel = new Float32Array(count * 3)
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  const mat = new THREE.PointsMaterial({ color: 0xff5a64, size: 0.42, transparent: true, opacity: 0, depthWrite: false, map: heartTexture() })
  const points = new THREE.Points(geo, mat)
  let life = 0
  return {
    points,
    fire () {
      life = 1.6
      for (let i = 0; i < count; i++) {
        pos.set([0, 0, 1], i * 3)
        const a = Math.random() * Math.PI * 2
        const s = 2 + Math.random() * 5
        vel.set([Math.cos(a) * s, Math.sin(a) * s + 2, (Math.random() - 0.3) * 3], i * 3)
      }
    },
    tick (dt) {
      if (life <= 0) { mat.opacity = 0; return }
      life -= dt
      mat.opacity = Math.min(1, life)
      for (let i = 0; i < count; i++) {
        vel[i * 3 + 1] -= 6 * dt
        for (let k = 0; k < 3; k++) pos[i * 3 + k] += vel[i * 3 + k] * dt
      }
      geo.attributes.position.needsUpdate = true
    }
  }
}
