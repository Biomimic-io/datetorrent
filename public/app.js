// DateTorrent web UI. Talks to the local server in lib/server.js. Peer data is
// untrusted, so the DOM is only ever built with h(), which inserts text nodes.

const $ = (sel, root = document) => root.querySelector(sel)
const main = $('#main')

// ------------------------------------------------------------------ icons
// Inline SVG paths (24px grid, stroke-based) so there's no icon font to fail.
const ICONS = {
  discover: '<rect x="5" y="3" width="14" height="18" rx="3"/><path d="M9 21h10a2 2 0 0 0 2-2V8"/>',
  chat: '<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.3A8 8 0 1 1 21 12Z"/>',
  person: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  network: '<circle cx="12" cy="5" r="2.5"/><circle cx="5" cy="18" r="2.5"/><circle cx="19" cy="18" r="2.5"/><path d="M10.8 7.2 6.2 15.8M13.2 7.2l4.6 8.6M7.5 18h9"/>',
  heart: '<path d="M12 20s-7.5-4.6-9.3-9.2C1.5 7.6 3.7 4.5 7 4.5c2 0 3.6 1.2 5 3 1.4-1.8 3-3 5-3 3.3 0 5.5 3.1 4.3 6.3C19.5 15.4 12 20 12 20Z" fill="currentColor" stroke="none"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.5"/>',
  photo: '<rect x="3" y="5" width="18" height="14" rx="3"/><circle cx="9" cy="10" r="1.8"/><path d="m21 16-5-5-8 8"/>',
  send: '<path d="M12 19V5M5 12l7-7 7 7"/>',
  back: '<path d="M15 5l-7 7 7 7"/>',
  chevron: '<path d="M9 5l7 7-7 7"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2.5"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.7 3.8 5.7 3.8 9s-1.3 6.3-3.8 9c-2.5-2.7-3.8-5.7-3.8-9S9.5 5.7 12 3Z"/>',
  sparkle: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3Z"/><path d="M19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8L19 16Z"/>',
  sync: '<path d="M20 11a8 8 0 0 0-14.3-4.9L4 8M4 4v4h4M4 13a8 8 0 0 0 14.3 4.9L20 16M20 20v-4h-4"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2.5"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="m11 12 9-9M17 6l3 3M14 9l2 2"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/>',
  block: '<circle cx="12" cy="12" r="9"/><path d="M5.6 5.6l12.8 12.8"/>',
  unmatch: '<path d="M12 20s-7.5-4.6-9.3-9.2C1.5 7.6 3.7 4.5 7 4.5c2 0 3.6 1.2 5 3 1.4-1.8 3-3 5-3 3.3 0 5.5 3.1 4.3 6.3C19.5 15.4 12 20 12 20Z"/><path d="M4 4l16 16"/>',
  server: '<rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 7.5h.01M7 16.5h.01"/>'
}
function icon (name, extra = '') {
  const span = document.createElement('span')
  span.style.display = 'contents'
  span.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ${extra}>${ICONS[name]}</svg>`
  return span.firstChild
}

// ------------------------------------------------------------------ basics

let state = null
let tab = remember('tab') || 'discover'
let openChat = remember('chat')
let discover3d = null

function remember (key, value) {
  try {
    if (value === undefined) return localStorage.getItem('dt.' + key)
    if (value === null) localStorage.removeItem('dt.' + key)
    else localStorage.setItem('dt.' + key, value)
  } catch {}
  return null
}

async function api (path, body) {
  let res
  try {
    res = await fetch('/api/' + path, body === undefined ? {} : {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-DateTorrent': '1' }, body: JSON.stringify(body)
    })
  } catch {
    throw new Error('Can’t reach the DateTorrent app. Is `datetorrent ui` still running?')
  }
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || res.statusText)
  return data
}

function h (tag, attrs = {}, ...kids) {
  const el = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v == null) continue
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v)
    else if (k === 'class') el.className = v
    else el.setAttribute(k, v === true ? '' : v)
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid instanceof Node ? kid : String(kid))
  return el
}

const photoUrl = (owner, obj) => `/api/photo/${owner}/${obj}`
const hue = (id) => parseInt(id.slice(0, 6), 16) % 360
const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`

function avatar (p, size = 44) {
  return h('div', { class: 'avatar', style: `--size:${size}px; background:hsl(${hue(p.id)} 50% 45%)`, 'aria-hidden': 'true' },
    p.photo ? h('img', { src: photoUrl(p.id, p.photo), alt: '', width: size, height: size, loading: 'lazy' }) : (p.name || '?')[0].toUpperCase())
}

const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
function ago (ms) {
  const s = (ms - Date.now()) / 1000
  if (Math.abs(s) < 60) return 'now'
  if (Math.abs(s) < 3600) return rtf.format(Math.round(s / 60), 'minute')
  if (Math.abs(s) < 86400) return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  if (Math.abs(s) < 7 * 86400) return new Date(ms).toLocaleDateString([], { weekday: 'short' })
  return new Date(ms).toLocaleDateString([], { month: 'short', day: 'numeric' })
}
function dayLabel (ms) {
  const d = new Date(ms)
  const today = new Date()
  const diff = Math.round((new Date(today.toDateString()) - new Date(d.toDateString())) / 86400000)
  if (diff === 0) return 'Today'
  if (diff === 1) return 'Yesterday'
  return d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })
}

// Snackbar (Material) with an optional action such as Undo.
let snackTimer
function snack (text, { action, onAction, kind, ms = 4200 } = {}) {
  $('.snackbar')?.remove()
  clearTimeout(snackTimer)
  const bar = h('div', { class: 'snackbar' + (kind ? ' ' + kind : ''), role: 'status' },
    h('span', {}, text),
    action && h('button', { class: 'btn plain', type: 'button', onclick: () => { bar.remove(); onAction() } }, action))
  document.body.append(bar)
  snackTimer = setTimeout(() => bar.remove(), action ? ms + 2000 : ms)
}

// Run an async action with a painted busy state on its button.
async function busy (btn, fn, label) {
  const original = btn ? [...btn.childNodes] : null
  if (btn) {
    btn.disabled = true
    btn.setAttribute('aria-busy', 'true')
    btn.replaceChildren(h('span', { class: 'spinner', 'aria-hidden': 'true' }), ...(label ? [label] : []))
  }
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  try {
    return await fn()
  } catch (e) {
    snack(e.message)
  } finally {
    if (btn && btn.isConnected) {
      btn.disabled = false
      btn.removeAttribute('aria-busy')
      btn.replaceChildren(...original)
    }
  }
}

// ------------------------------------------------------------------ dialogs

function sheet ({ title, body, foot, className = 'sheet', onClose }) {
  const close = h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Close', onclick: () => dlg.close() }, icon('close'))
  const dlg = h('dialog', { class: className, 'aria-label': title },
    title && h('div', { class: 'sheet-head' }, h('h2', {}, title), close),
    h('div', { class: 'sheet-body' }, body),
    foot && h('div', { class: 'sheet-foot' }, foot))
  dlg.addEventListener('close', () => { dlg.remove(); onClose?.() })
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close() }) // tap outside
  document.body.append(dlg)
  dlg.showModal()
  return dlg
}

function confirmSheet ({ title, message, confirm, destructive = true }) {
  return new Promise((resolve) => {
    let answer = false
    const yes = h('button', { class: 'btn ' + (destructive ? 'danger-fill' : 'primary'), type: 'button', onclick: () => { answer = true; dlg.close() } }, confirm)
    const no = h('button', { class: 'btn', type: 'button', onclick: () => dlg.close() }, 'Cancel')
    const dlg = sheet({ title, body: h('p', { style: 'margin:0;color:var(--label-2)' }, message), foot: [no, yes], onClose: () => resolve(answer) })
    no.focus()
  })
}

function lightbox (owner, objs, start = 0) {
  let i = start
  const img = h('img', { alt: '' })
  const count = h('div', { class: 'count', 'aria-live': 'polite' })
  const show = () => { img.src = photoUrl(owner, objs[i]); img.alt = `Photo ${i + 1} of ${objs.length}`; count.textContent = `${i + 1} / ${objs.length}` }
  const step = (d) => { i = (i + d + objs.length) % objs.length; show() }
  const multi = objs.length > 1
  const dlg = h('dialog', { class: 'lightbox', 'aria-label': 'Photo viewer' },
    img,
    h('button', { class: 'icon-btn close', type: 'button', 'aria-label': 'Close', onclick: () => dlg.close() }, icon('close')),
    multi && h('button', { class: 'icon-btn prev', type: 'button', 'aria-label': 'Previous photo', onclick: () => step(-1) }, icon('back')),
    multi && h('button', { class: 'icon-btn next', type: 'button', 'aria-label': 'Next photo', onclick: () => step(1) }, icon('chevron')),
    multi && count)
  dlg.addEventListener('keydown', (e) => { if (e.key === 'ArrowLeft') step(-1); if (e.key === 'ArrowRight') step(1) })
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close() })
  dlg.addEventListener('close', () => dlg.remove())
  document.body.append(dlg)
  show()
  dlg.showModal()
}

// ------------------------------------------------------------------ shell

const TABS = [
  ['discover', 'Discover', 'discover'],
  ['matches', 'Matches', 'chat'],
  ['profile', 'Profile', 'person'],
  ['network', 'Network', 'network']
]

function renderTabs () {
  const nav = $('#tabs')
  nav.replaceChildren(...TABS.map(([id, label, ic]) =>
    h('button', { class: 'tab', type: 'button', 'aria-current': tab === id ? 'page' : 'false', onclick: () => setTab(id) },
      icon(ic), h('span', {}, label), id === 'matches' && h('span', { class: 'badge', id: 'matchBadge', hidden: true }))))
}

function setTab (next) {
  if (next === tab && main.childElementCount) return
  tab = next
  remember('tab', tab)
  render()
}

async function render () {
  if (discover3d) { discover3d.destroy(); discover3d = null }
  try {
    state = await api('state')
  } catch (e) {
    main.replaceChildren(emptyState('network', 'Can’t load DateTorrent', e.message, h('button', { class: 'btn primary', onclick: render }, 'Try again')))
    return
  }
  const ready = state.initialized && state.me
  $('#tabs').hidden = !ready
  if (ready) renderTabs()
  main.replaceChildren()
  if (!state.initialized) return renderWelcome()
  if (!state.me) return renderProfile(true)
  document.title = `${TABS.find((t) => t[0] === tab)?.[1] || 'DateTorrent'} · DateTorrent`
  refreshBadge()
  const views = { discover: renderDiscover, matches: renderMatches, profile: () => renderProfile(false), network: renderNetwork }
  return (views[tab] || renderDiscover)()
}

async function refreshBadge () {
  try {
    const ms = await api('matches')
    const b = $('#matchBadge')
    if (!b) return
    b.hidden = !ms.length
    b.textContent = ms.length
    b.setAttribute('aria-label', plural(ms.length, 'match', 'matches'))
  } catch {}
}

function pageHead (title, sub, ...extra) {
  return h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, title), sub && h('p', {}, sub)), h('div', { class: 'spacer' }), ...extra)
}

function emptyState (ic, title, text, ...actions) {
  return h('div', { class: 'empty' }, h('div', { class: 'glyph' }, icon(ic)), h('h2', {}, title), h('p', {}, text), ...actions)
}

// ------------------------------------------------------------------ welcome

function renderWelcome () {
  document.title = 'Welcome · DateTorrent'
  const feature = (ic, color, title, text) => h('div', { class: 'feature' },
    h('div', { class: 'icon-tile', style: `background:${color}` }, icon(ic)), h('div', {}, h('strong', {}, title), h('span', {}, text)))
  const start = h('button', { class: 'btn primary block', type: 'button', onclick: (e) => busy(e.currentTarget, async () => { await api('init', {}); render() }, 'Creating keys…') }, 'Get started')
  main.append(h('div', { class: 'welcome' },
    h('div', { class: 'logo' }, brandMark()),
    h('h1', {}, 'Dating without a server.'),
    h('p', {}, 'Your profile lives in a database people share peer-to-peer. Nobody owns it, including us.'),
    h('div', { class: 'features' },
      feature('lock', '#e11d48', 'Private by default', 'Photos, likes and messages are encrypted on this device. Only the people you choose can open them.'),
      feature('sparkle', '#7c3aed', 'Matching stays local', 'Compatibility is worked out on your computer, not on someone else’s server.'),
      feature('globe', '#0a84ff', 'Shared over GitTorrent', 'Everyone keeps a copy of the network, so it can’t be switched off.')),
    start,
    h('p', { class: 'section-foot', style: 'text-align:center;margin-top:14px' }, `Creates your keys in ${state.home}. Keep that folder safe.`)))
}

function brandMark () {
  const span = document.createElement('span')
  span.style.display = 'contents'
  span.innerHTML = '<svg viewBox="0 0 32 32" aria-hidden="true"><circle cx="12" cy="16" r="7.5" fill="#e11d48"/><circle cx="20" cy="16" r="7.5" fill="none" stroke="#e11d48" stroke-width="3"/></svg>'
  return span.firstChild
}

// ------------------------------------------------------------------ discover

async function renderDiscover () {
  const admirers = h('div', {})
  main.append(pageHead('Discover', 'Ranked on this device from your copy of the network.', admirers))
  const wrap = h('div', { class: 'stage-wrap' },
    h('div', { class: 'stage' }, h('div', { class: 'stage-skeleton', 'aria-label': 'Loading profiles', role: 'status' }, h('div', { class: 'skeleton' }))))
  main.append(wrap)

  let data
  try {
    data = await api('discover')
  } catch (e) {
    wrap.replaceChildren(emptyState('discover', 'Couldn’t load profiles', e.message, h('button', { class: 'btn primary', onclick: render }, 'Try again')))
    return
  }
  if (tab !== 'discover') return
  if (data.admirers) {
    admirers.replaceChildren(h('span', { class: 'admirers' }, icon('heart'), `${plural(data.admirers, 'person likes', 'people like')} you`))
  }
  const empty = () => emptyState('discover', 'You’re all caught up',
    'There are no more compatible profiles in your copy of the network. Add peers or sync to find more people.',
    h('button', { class: 'btn primary', onclick: () => setTab('network') }, icon('network'), 'Find more people'))
  if (!data.candidates.length) { wrap.replaceChildren(empty()); return }

  const onDecision = async (p, dir, c) => {
    if (dir === 'pass') {
      await api('pass', { id: p.id })
      snack(`Passed on ${p.name}`, {
        action: 'Undo',
        onAction: async () => {
          await api('unpass', { id: p.id }).catch((e) => snack(e.message))
          if (discover3d) discover3d.restore(c)
          else render()
        }
      })
      return false
    }
    const r = await api('like', { id: p.id })
    if (r.matched) { refreshBadge(); showMatch(p) } else snack(`You liked ${p.name}. They’ll see it after the next sync.`)
    return r.matched
  }

  try {
    const { mountDiscover } = await import('/discover3d.js')
    const host = h('div', {})
    wrap.replaceChildren(host)
    discover3d = mountDiscover(host, {
      candidates: data.candidates,
      photoUrl,
      icon,
      onDecision: (p, dir, c) => onDecision(p, dir, c).catch((e) => { snack(e.message); return false }),
      onEmpty: () => { if (discover3d) { discover3d.destroy(); discover3d = null } wrap.replaceChildren(empty()) }
    })
  } catch (e) {
    console.warn('3D discover unavailable, using the list view:', e)
    wrap.replaceChildren(discoverList(data.candidates, onDecision))
  }
}

// Fallback without WebGL: the same actions as simple cards.
function discoverList (candidates, onDecision) {
  const grid = h('div', { class: 'photo-grid', style: 'grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:16px' })
  for (const c of candidates) {
    const p = c.profile
    const card = h('article', { class: 'group' },
      p.photo && h('img', { src: photoUrl(p.id, p.photo), alt: `${p.name}’s photo`, style: 'width:100%;aspect-ratio:3/4;object-fit:cover;display:block', loading: 'lazy' }),
      h('div', { class: 'row stack' },
        h('div', { class: 'title' }, `${p.name}, ${p.age} · ${c.score}% match`),
        h('div', { class: 'sub' }, p.bio),
        h('div', { style: 'display:flex;gap:8px' },
          h('button', { class: 'btn block', onclick: (e) => busy(e.currentTarget, async () => { await onDecision(p, 'pass', c); card.remove() }) }, icon('close'), 'Pass'),
          h('button', { class: 'btn primary block', onclick: (e) => busy(e.currentTarget, async () => { await onDecision(p, 'like', c); card.remove() }) }, icon('heart'), 'Like'))))
    grid.append(card)
  }
  return grid
}

function showMatch (p) {
  const me = state.me
  const message = h('button', { class: 'btn block', type: 'button', onclick: () => { dlg.close(); openChat = p.id; remember('chat', p.id); setTab('matches') } }, icon('chat'), `Message ${p.name}`)
  const keep = h('button', { class: 'btn ghost block', type: 'button', onclick: () => dlg.close() }, 'Keep swiping')
  const dlg = sheet({
    title: null,
    body: h('div', { class: 'match-card' },
      h('div', { class: 'pair' }, avatar(me, 96), avatar(p, 96)),
      h('h2', {}, 'It’s a match!'),
      h('p', {}, `You and ${p.name} like each other.`),
      message, keep)
  })
  dlg.querySelector('.sheet-body').style.padding = '0'
  message.focus()
}

// ------------------------------------------------------------------ matches

async function renderMatches () {
  main.append(pageHead('Matches', 'Messages and shared photos are end-to-end encrypted.'))
  const layout = h('div', { class: 'chat-layout' },
    h('div', { class: 'group chat-list' }, [0, 1, 2].map(() => h('div', { class: 'chat-item' }, h('div', { class: 'skeleton', style: 'width:44px;height:44px;border-radius:50%' }), h('div', { class: 'grow' }, h('div', { class: 'skeleton', style: 'height:12px;width:60%;margin-bottom:8px' }), h('div', { class: 'skeleton', style: 'height:10px;width:85%' }))))),
    h('div', { class: 'group conversation' }))
  main.append(layout)
  let ms
  try { ms = await api('matches') } catch (e) {
    layout.replaceWith(emptyState('chat', 'Couldn’t load matches', e.message, h('button', { class: 'btn primary', onclick: render }, 'Try again')))
    return
  }
  if (tab !== 'matches') return
  if (!ms.length) {
    layout.replaceWith(emptyState('heart', 'No matches yet', 'When someone you like likes you back, you can chat and share private photos here.',
      h('button', { class: 'btn primary', onclick: () => setTab('discover') }, icon('discover'), 'Go to Discover')))
    return
  }
  ms.sort((a, b) => b.last - a.last)
  const narrow = matchMedia('(max-width: 720px)').matches
  if (!ms.some((m) => m.profile.id === openChat)) openChat = narrow ? null : ms[0].profile.id
  const current = ms.find((m) => m.profile.id === openChat)
  layout.classList.toggle('open', !!current)

  const list = layout.firstChild
  list.replaceChildren(...ms.map((m) => {
    const last = m.timeline[m.timeline.length - 1]
    const preview = !last
      ? ['New match. Say hi!']
      : last.kind === 'photos'
        ? [icon('photo'), last.mine ? `You shared ${plural(last.photos.length, 'photo')}` : `Shared ${plural(last.photos.length, 'photo')} with you`]
        : [(last.mine ? 'You: ' : '') + last.text]
    return h('button', {
      class: 'chat-item', type: 'button', 'aria-current': String(m.profile.id === openChat),
      onclick: () => { openChat = m.profile.id; remember('chat', openChat); render() }
    }, avatar(m.profile, 48), h('div', { class: 'grow' },
      h('div', { class: 'name' }, h('span', {}, m.profile.name), h('time', {}, ago(m.last))),
      h('div', { class: 'preview' }, ...preview)))
  }))

  const conv = layout.lastChild
  if (current) renderConversation(conv, current)
  else conv.replaceChildren(h('div', { class: 'empty-chat' }, 'Choose a match to start chatting.'))
}

function renderConversation (conv, m) {
  const p = m.profile
  const timeline = h('div', { class: 'timeline', role: 'log', 'aria-label': `Conversation with ${p.name}`, 'aria-live': 'polite' })
  const draftKey = 'draft:' + p.id
  const input = h('input', { type: 'text', placeholder: 'Message', maxlength: '2000', 'aria-label': `Message ${p.name}`, value: sessionStorage.getItem(draftKey) || '' })
  const send = h('button', { class: 'icon-btn send', type: 'submit', 'aria-label': 'Send', disabled: !input.value.trim() }, icon('send'))
  input.addEventListener('input', () => {
    send.disabled = !input.value.trim()
    try { sessionStorage.setItem(draftKey, input.value) } catch {}
  })
  const attach = h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Share private photos', title: 'Share private photos', onclick: () => shareSheet(m) }, icon('photo'))

  const form = h('form', { class: 'composer', onsubmit: async (e) => {
    e.preventDefault()
    const text = input.value.trim()
    if (!text) return
    // Optimistic: show the bubble now, reconcile after the commit.
    const bubble = h('div', { class: 'bubble mine tail-mine pending' }, text)
    const status = h('div', { class: 'meta-line mine' }, 'Sending…')
    timeline.querySelector('.empty-chat')?.remove()
    timeline.append(bubble, status)
    timeline.scrollTop = timeline.scrollHeight
    input.value = ''
    send.disabled = true
    try { sessionStorage.removeItem(draftKey) } catch {}
    try {
      await api('message', { id: p.id, text })
      bubble.classList.remove('pending')
      status.textContent = 'Sealed · delivers on next sync'
    } catch (err) {
      bubble.className = 'bubble mine failed'
      status.replaceChildren('Not sent. ', h('button', { class: 'btn plain small', type: 'button', onclick: () => { input.value = text; bubble.remove(); status.remove(); form.requestSubmit() } }, 'Retry'))
      snack(err.message)
    }
  } }, attach, input, send)

  // Timeline: day separators, grouped bubbles, photo shares inline.
  let lastDay = ''
  m.timeline.forEach((item, i) => {
    const day = dayLabel(item.at)
    if (day !== lastDay) { timeline.append(h('div', { class: 'day' }, day)); lastDay = day }
    const next = m.timeline[i + 1]
    const endsRun = !next || next.mine !== item.mine || next.kind !== item.kind || next.at - item.at > 5 * 60000
    if (item.kind === 'msg') {
      timeline.append(h('div', { class: 'bubble' + (item.mine ? ' mine' : '') + (endsRun ? (item.mine ? ' tail-mine' : ' tail-theirs') : '') }, item.text))
      if (endsRun) timeline.append(h('div', { class: 'meta-line' + (item.mine ? ' mine' : '') }, new Date(item.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })))
    } else {
      timeline.append(shareBubble(item, p))
    }
  })
  if (!m.timeline.length) {
    timeline.append(h('div', { class: 'empty-chat' },
      avatar(p, 84),
      h('strong', { style: 'color:var(--label);font-size:18px' }, `You matched with ${p.name}`),
      h('span', {}, 'Say hello, or share a private photo. Only the two of you can see what you send here.'),
      h('button', { class: 'btn small', type: 'button', onclick: () => shareSheet(m) }, icon('photo'), 'Share photos')))
  }

  conv.replaceChildren(
    h('div', { class: 'conv-head' },
      h('button', { class: 'icon-btn back', type: 'button', 'aria-label': 'Back to matches', onclick: () => { openChat = null; remember('chat', null); render() } }, icon('back')),
      h('button', { class: 'who', type: 'button', onclick: () => profileSheet(m), 'aria-label': `View ${p.name}’s profile` },
        avatar(p, 38), h('div', {}, h('div', { class: 'title' }, `${p.name}, ${p.age}`), h('div', { class: 'sub' }, `${p.region || ''} · View profile`))),
      h('div', { style: 'flex:1' }),
      h('button', { class: 'icon-btn', type: 'button', 'aria-label': `${p.name}’s profile and options`, onclick: () => profileSheet(m) }, icon('info'))),
    timeline, form)
  // Stay pinned to the newest item while photos decode (their boxes are
  // pre-sized, but the first paint can still land a frame early).
  const pin = () => { timeline.scrollTop = timeline.scrollHeight }
  pin()
  requestAnimationFrame(pin)
  for (const img of timeline.querySelectorAll('img')) img.addEventListener('load', () => { if (timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight < 400) pin() }, { once: true })
}

function shareBubble (item, p) {
  const n = item.photos.length
  const objs = item.photos.filter((x) => x.available).map((x) => x.obj)
  const tiles = item.photos.slice(0, 4).map((x, i) => x.available
    ? h('button', { class: 'photo-tile', type: 'button', 'aria-label': `Open shared photo ${i + 1} of ${n}`, onclick: () => lightbox(item.owner, objs, Math.max(0, objs.indexOf(x.obj))) },
      h('img', { src: photoUrl(item.owner, x.obj), alt: '', loading: 'lazy', width: 180, height: 180 }),
      i === 3 && n > 4 ? h('span', { class: 'corner' }, `+${n - 4}`) : null)
    : h('div', { class: 'photo-tile' }, h('span', { class: 'gone' }, 'Photo removed')))
  const caption = item.mine ? `You shared ${plural(n, 'private photo')}` : `${p.name} shared ${plural(n, 'private photo')} with you`
  return h('div', { class: 'share-bubble' + (item.mine ? ' mine' : '') + (n === 1 ? ' single' : '') },
    h('div', { class: 'photos', style: `--cols:${Math.min(2, tiles.length)}` }, tiles),
    h('div', { class: 'caption' }, icon('lock'), `${caption} · ${new Date(item.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`))
}

// Pick private photos to give a match. Each sends that photo's key, sealed to them.
async function shareSheet (m) {
  const p = m.profile
  const body = h('div', {}, h('div', { class: 'photo-grid' }, [0, 1, 2].map(() => h('div', { class: 'photo-tile skeleton' }))))
  const share = h('button', { class: 'btn primary', type: 'button', disabled: true }, 'Select photos')
  const cancel = h('button', { class: 'btn', type: 'button', onclick: () => dlg.close() }, 'Cancel')
  const dlg = sheet({ title: `Share with ${p.name}`, body, foot: [cancel, share] })
  let mine
  try { mine = await api('photos') } catch (e) { body.replaceChildren(h('p', { class: 'field-error' }, e.message)); return }
  const options = mine.filter((x) => !x.public)
  if (!options.length) {
    body.replaceChildren(emptyState('photo', 'No private photos yet', 'Add photos on your Profile and keep them private. Then you can choose who sees them.',
      h('button', { class: 'btn primary', type: 'button', onclick: () => { dlg.close(); setTab('profile') } }, 'Go to Profile')))
    share.hidden = true
    return
  }
  const boxes = options.map((x) => {
    const already = x.sharedWith.includes(p.id)
    const box = h('input', { type: 'checkbox', disabled: already, checked: already, 'aria-label': already ? 'Already shared' : 'Share this photo' })
    return { x, box, already }
  })
  const update = () => {
    const n = boxes.filter((b) => b.box.checked && !b.already).length
    share.disabled = !n
    share.textContent = n ? `Share ${plural(n, 'photo')}` : 'Select photos'
  }
  boxes.forEach((b) => b.box.addEventListener('change', update))
  body.replaceChildren(
    h('div', { class: 'photo-grid' }, boxes.map(({ x, box, already }) => h('label', { class: 'photo-tile' },
      box, h('img', { src: photoUrl(state.myId, x.obj), alt: '', loading: 'lazy' }), h('span', { class: 'check' }, icon('check')),
      already && h('span', { class: 'corner' }, icon('check'), 'Shared')))),
    h('p', { class: 'section-foot', style: 'margin:14px 0 0' }, `${p.name} will get a permanent key to each photo. Unmatching stops future sharing, but can’t take these back.`))
  share.onclick = () => busy(share, async () => {
    const objs = boxes.filter((b) => b.box.checked && !b.already).map((b) => b.x.obj)
    await api('photos/share', { id: p.id, objs })
    dlg.close()
    snack(`Shared ${plural(objs.length, 'photo')} with ${p.name}`)
    render()
  }, 'Sharing…')
}

function profileSheet (m) {
  const p = m.profile
  const objs = m.photos.map((x) => x.obj)
  const unmatch = h('button', { class: 'btn danger block', type: 'button', onclick: async () => {
    if (!await confirmSheet({ title: `Unmatch ${p.name}?`, message: `You’ll both lose this conversation. ${p.name} keeps any photos you already shared.`, confirm: 'Unmatch' })) return
    busy(unmatch, async () => { await api('unlike', { id: p.id }); dlg.close(); openChat = null; remember('chat', null); snack(`Unmatched ${p.name}`); render() })
  } }, icon('unmatch'), 'Unmatch')
  const block = h('button', { class: 'btn danger block', type: 'button', onclick: async () => {
    if (!await confirmSheet({ title: `Block ${p.name}?`, message: `They won’t appear in Discover and you won’t see their messages. Only you know you blocked them.`, confirm: 'Block' })) return
    busy(block, async () => { await api('block', { id: p.id }); dlg.close(); openChat = null; remember('chat', null); snack(`Blocked ${p.name}`); render() })
  } }, icon('block'), 'Block')
  const dlg = sheet({
    title: `${p.name}, ${p.age}`,
    body: h('div', { style: 'display:grid;gap:16px' },
      objs.length
        ? h('div', { class: 'photo-grid' }, m.photos.map((x, i) => h('button', { class: 'photo-tile', type: 'button', 'aria-label': `Open photo ${i + 1}`, onclick: () => lightbox(p.id, objs, i) },
          h('img', { src: photoUrl(p.id, x.obj), alt: '', loading: 'lazy' }),
          h('span', { class: 'corner' }, icon(x.public ? 'globe' : 'lock'), x.public ? 'Public' : 'Shared with you'))))
        : h('p', { class: 'section-foot' }, 'No photos yet.'),
      h('div', { class: 'group' },
        h('div', { class: 'row' }, h('div', { class: 'grow' }, h('div', { class: 'sub' }, 'About'), h('div', {}, p.bio || '—'))),
        h('div', { class: 'row' }, h('div', { class: 'grow' }, h('div', { class: 'sub' }, 'Lives in'), h('div', {}, p.region || '—'))),
        h('div', { class: 'row' }, h('div', { class: 'grow' }, h('div', { class: 'sub' }, 'Interests'), h('div', { class: 'chips', style: 'margin-top:4px' }, p.interests.map((i) => h('span', { class: 'tag' }, i)))))),
      h('div', { style: 'display:grid;gap:8px' }, unmatch, block))
  })
}

// ------------------------------------------------------------------ profile

function renderProfile (first) {
  const me = state.me || { seeking: [], interests: [], ageMin: 25, ageMax: 45 }
  const draftKey = 'profile-draft'
  let draft = {}
  try { draft = JSON.parse(sessionStorage.getItem(draftKey) || '{}') } catch {}
  const val = (k, fallback = '') => draft[k] ?? me[k] ?? fallback

  main.append(pageHead(first ? 'Create your profile' : 'Profile', first ? 'This is what people see in Discover. You can change it any time.' : 'Signed with your key, so nobody else can edit it.'))
  const wrapper = h('div', { class: 'narrow' })
  main.append(wrapper)

  if (!first) {
    const photos = h('div', {})
    wrapper.append(h('div', { class: 'section-title' }, 'Photos'), h('div', { class: 'group', style: 'padding:12px' }, photos),
      h('p', { class: 'section-foot' }, 'Every photo is encrypted on this device with its own key. Public photos appear on your card; private ones are only for matches you choose.'))
    renderPhotoManager(photos)
  }

  const field = (label, input, hint) => h('div', { class: 'row stack' }, h('label', { class: 'field-label', for: input.id }, label), input, hint && h('div', { class: 'sub' }, hint))
  const input = (name, attrs = {}) => h('input', { id: 'f-' + name, name, value: val(name, attrs.value ?? ''), ...attrs })
  const errors = {}
  const withError = (name, el) => {
    errors[name] = h('div', { class: 'field-error', id: 'err-' + name, role: 'alert' })
    el.setAttribute('aria-describedby', 'err-' + name)
    return [el, errors[name]]
  }
  const [nameEl, nameErr] = withError('name', input('name', { required: true, maxlength: '40', autocomplete: 'nickname' }))
  const [ageEl, ageErr] = withError('age', input('age', { type: 'number', min: '18', max: '120', inputmode: 'numeric', required: true }))
  const gender = h('select', { id: 'f-gender', name: 'gender', required: true },
    h('option', { value: '' }, 'Choose…'), state.genders.map((g) => h('option', { value: g, selected: val('gender') === g }, g[0].toUpperCase() + g.slice(1))))
  const seekingVal = draft.seeking ?? me.seeking
  const seeking = h('div', { class: 'chips', role: 'group', 'aria-labelledby': 'seeking-label' }, state.genders.map((g) =>
    h('label', { class: 'chip-toggle' }, h('input', { type: 'checkbox', name: 'seeking', value: g, checked: seekingVal.includes(g) }), h('span', {}, icon('check'), g[0].toUpperCase() + g.slice(1)))))
  const seekingErr = h('div', { class: 'field-error', role: 'alert' })
  const [minEl, rangeErr] = withError('ageMin', input('ageMin', { type: 'number', min: '18', max: '120', inputmode: 'numeric', required: true }))
  const maxEl = input('ageMax', { type: 'number', min: '18', max: '120', inputmode: 'numeric', required: true })
  const bio = h('textarea', { id: 'f-bio', name: 'bio', maxlength: '500' }, val('bio'))
  const bioCount = h('div', { class: 'sub', 'aria-live': 'polite' })
  const countBio = () => { bioCount.textContent = `${bio.value.length} / 500` }
  bio.addEventListener('input', countBio)
  countBio()
  const interests = input('interests', { value: (draft.interests ?? me.interests.join(', ')), placeholder: 'climbing, jazz, sourdough' })
  interests.value = draft.interests ?? me.interests.join(', ')
  const save = h('button', { class: 'btn primary block', type: 'submit' }, first ? 'Create profile' : 'Save changes')
  const dirtyNote = h('p', { class: 'section-foot', role: 'status', hidden: !Object.keys(draft).length }, 'You have unsaved changes.')

  const form = h('form', { novalidate: true, onsubmit: (e) => {
    e.preventDefault()
    const d = new FormData(form)
    const body = Object.fromEntries(d)
    body.seeking = d.getAll('seeking')
    // Inline validation, keeping everything the user typed.
    for (const el of Object.values(errors)) el.textContent = ''
    seekingErr.textContent = ''
    const problems = []
    if (!body.name.trim()) problems.push(['name', 'Add a display name.'])
    if (!(+body.age >= 18)) problems.push(['age', 'You must be 18 or older.'])
    if (!body.seeking.length) seekingErr.textContent = 'Choose at least one.'
    if (!(+body.ageMin >= 18) || +body.ageMin > +body.ageMax) problems.push(['ageMin', 'Use an age range of 18 or more, youngest first.'])
    for (const [k, msg] of problems) { errors[k].textContent = msg; form.elements[k]?.setAttribute('aria-invalid', 'true') }
    if (!body.gender) { snack('Choose your gender.'); gender.focus(); return }
    if (problems.length || !body.seeking.length) { form.elements[problems[0]?.[0]]?.focus(); return }
    busy(save, async () => {
      await api('profile', body)
      try { sessionStorage.removeItem(draftKey) } catch {}
      snack(first ? 'Profile created' : 'Profile saved')
      if (first) tab = 'discover'
      render()
    }, 'Saving…')
  } },
  h('div', { class: 'section-title' }, 'About you'),
  h('div', { class: 'group' },
    field('Display name', nameEl), h('div', { style: 'padding:0 16px' }, nameErr),
    h('div', { class: 'row stack' }, h('div', { class: 'grid-2' },
      h('div', { style: 'display:grid;gap:6px' }, h('label', { class: 'field-label', for: 'f-age' }, 'Age'), ageEl, ageErr),
      h('div', { style: 'display:grid;gap:6px' }, h('label', { class: 'field-label', for: 'f-gender' }, 'I am'), gender))),
    field('Region', input('region', { maxlength: '60', placeholder: 'Portland, OR', autocomplete: 'address-level2' }), 'Keep it broad: a city or region, never an address.')),
  h('div', { class: 'section-title', id: 'seeking-label' }, 'Looking for'),
  h('div', { class: 'group' },
    h('div', { class: 'row stack' }, seeking, seekingErr),
    h('div', { class: 'row stack' }, h('div', { class: 'grid-2' },
      h('div', { style: 'display:grid;gap:6px' }, h('label', { class: 'field-label', for: 'f-ageMin' }, 'Youngest'), minEl),
      h('div', { style: 'display:grid;gap:6px' }, h('label', { class: 'field-label', for: 'f-ageMax' }, 'Oldest'), maxEl)), rangeErr)),
  h('div', { class: 'section-title' }, 'More about you'),
  h('div', { class: 'group' },
    field('Interests', interests, 'Separate with commas. Shared interests raise your match score.'),
    h('div', { class: 'row stack' }, h('label', { class: 'field-label', for: 'f-bio' }, 'Bio'), bio, bioCount)),
  h('p', { class: 'section-foot' }, 'Your profile is public and permanent: every peer keeps a copy, and old versions stay in history. Leave out your full name, address, workplace and contact details.'),
  h('div', { style: 'margin-top:20px' }, save), dirtyNote)

  // Keep unsaved edits if the user switches tabs.
  form.addEventListener('input', () => {
    const d = new FormData(form)
    const obj = Object.fromEntries(d)
    obj.seeking = d.getAll('seeking')
    try { sessionStorage.setItem(draftKey, JSON.stringify(obj)) } catch {}
    dirtyNote.hidden = false
    for (const el of form.querySelectorAll('[aria-invalid]')) el.removeAttribute('aria-invalid')
  })
  wrapper.append(form)

  if (!first) {
    const backup = h('button', { class: 'btn plain', type: 'button', onclick: () => recoverySheet() }, 'Create')
    const remove = h('button', { class: 'btn danger', type: 'button', onclick: async () => {
      if (!await confirmSheet({ title: 'Remove your profile?', message: 'This publishes a signed removal notice, so peers stop showing you. Copies already in git history can’t be recalled, and matches keep photos you shared.', confirm: 'Remove profile' })) return
      busy(remove, async () => { await api('profile/delete', {}); snack('Profile removed'); render() })
    } }, icon('trash'), 'Remove my profile')
    wrapper.append(
      h('div', { class: 'section-title' }, 'Account'),
      h('div', { class: 'group' },
        h('div', { class: 'row' }, h('div', { class: 'icon-tile', style: 'background:#0a84ff' }, icon('key')),
          h('div', { class: 'grow' }, h('div', { class: 'title' }, 'Recovery code'), h('div', { class: 'sub' }, 'Restore your account on a new device from any peer.')), backup)),
      h('div', { class: 'section-title' }, 'Danger zone'),
      h('div', { class: 'group' }, h('div', { class: 'row' }, remove)))
  }
}

async function renderPhotoManager (box) {
  box.replaceChildren(h('div', { class: 'photo-grid' }, [0, 1, 2].map(() => h('div', { class: 'photo-tile skeleton' }))))
  let photos
  try { photos = await api('photos') } catch (e) { box.replaceChildren(h('p', { class: 'field-error' }, e.message)); return }
  const file = h('input', { type: 'file', accept: 'image/*', hidden: true })
  const grid = h('div', { class: 'photo-grid' })
  const addTile = h('button', { class: 'photo-tile add', type: 'button', onclick: () => file.click(), 'aria-label': 'Add a photo' },
    h('div', {}, icon('plus'), 'Add photo'))
  file.addEventListener('change', async () => {
    const f = file.files[0]
    file.value = ''
    if (!f) return
    // Optimistic tile with a spinner while we resize, encrypt and commit.
    const pending = h('div', { class: 'photo-tile busy', role: 'status', 'aria-label': 'Encrypting photo' }, h('span', { class: 'spinner' }))
    addTile.before(pending)
    const makePublic = !photos.some((p) => p.public) // first photo becomes your card photo
    try {
      const { obj } = await api('photos', { data: await prepareUpload(f), public: makePublic })
      snack(makePublic ? 'Added as your public card photo' : 'Photo added privately', makePublic ? {} : {
        action: 'Make public', onAction: () => api('photos/public', { obj, public: true }).then(() => renderPhotoManager(box)).catch((e) => snack(e.message))
      })
      renderPhotoManager(box)
    } catch (e) {
      pending.remove()
      snack(e.message.includes('JPEG') || e.message.includes('Corrupt') ? 'That image couldn’t be read. Try a JPEG or PNG.' : e.message)
    }
  })
  grid.append(...photos.map((p) => h('button', { class: 'photo-tile', type: 'button', 'aria-label': `${p.public ? 'Public' : 'Private'} photo${p.sharedWith.length ? `, shared with ${plural(p.sharedWith.length, 'match', 'matches')}` : ''}. Open options.`, onclick: () => photoSheet(p, () => renderPhotoManager(box)) },
    h('img', { src: photoUrl(state.myId, p.obj), alt: '', loading: 'lazy' }),
    h('span', { class: 'corner' }, icon(p.public ? 'globe' : 'lock'), p.public ? 'Public' : p.sharedWith.length ? `Shared · ${p.sharedWith.length}` : 'Private'))), addTile, file)
  box.replaceChildren(grid)
}

function photoSheet (p, done) {
  const radio = (value, label, ic) => h('label', {}, h('input', { type: 'radio', name: 'vis', value, checked: p.public === (value === 'public') }), h('span', {}, icon(ic), label))
  const seg = h('div', { class: 'segmented', role: 'radiogroup', 'aria-label': 'Who can see this photo' }, radio('public', 'Public', 'globe'), radio('private', 'Private', 'lock'))
  const explain = h('p', { class: 'section-foot', style: 'margin:8px 0 0' })
  const setExplain = (pub) => { explain.textContent = pub ? 'Anyone on the network can see this photo on your card.' : 'Only matches you share it with can see it. Making a public photo private only affects people who haven’t seen it yet.' }
  setExplain(p.public)
  seg.addEventListener('change', (e) => {
    const pub = e.target.value === 'public'
    setExplain(pub)
    api('photos/public', { obj: p.obj, public: pub }).then(() => { p.public = pub; snack(pub ? 'Photo is now public' : 'Photo is now private'); done() })
      .catch((err) => { snack(err.message); seg.querySelector(`input[value="${p.public ? 'public' : 'private'}"]`).checked = true; setExplain(p.public) })
  })
  const remove = h('button', { class: 'btn danger block', type: 'button', onclick: async () => {
    dlg.close()
    if (!await confirmSheet({ title: 'Remove this photo?', message: p.sharedWith.length ? `It disappears from your profile. The ${plural(p.sharedWith.length, 'match', 'matches')} you shared it with may keep a copy.` : 'It disappears from your profile and this device.', confirm: 'Remove photo' })) return
    try { await api('photos/remove', { obj: p.obj }); snack('Photo removed'); done() } catch (e) { snack(e.message) }
  } }, icon('trash'), 'Remove photo')
  const dlg = sheet({
    title: 'Photo',
    body: h('div', { style: 'display:grid;gap:16px' },
      h('img', { src: photoUrl(state.myId, p.obj), alt: 'Your photo', style: 'width:100%;max-height:52vh;object-fit:contain;border-radius:14px;background:var(--fill)' }),
      h('div', {}, seg, explain),
      p.sharedWith.length > 0 && h('p', { class: 'section-foot', style: 'margin:0' }, `Shared privately with ${plural(p.sharedWith.length, 'match', 'matches')}.`),
      remove)
  })
}

// Resize and re-encode in the browser. Drawing to a canvas bakes in rotation
// and drops every byte of EXIF/GPS metadata; the server strips again anyway.
async function prepareUpload (file) {
  const bitmap = await createImageBitmap(file)
  const scale = Math.min(1, 1280 / Math.max(bitmap.width, bitmap.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(bitmap.width * scale)
  canvas.height = Math.round(bitmap.height * scale)
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85))
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(bin)
}

function recoverySheet () {
  const create = h('button', { class: 'btn primary', type: 'button' }, 'Create recovery code')
  const cancel = h('button', { class: 'btn', type: 'button', onclick: () => dlg.close() }, 'Cancel')
  const body = h('div', { style: 'display:grid;gap:12px' },
    h('p', { style: 'margin:0' }, 'A recovery code restores your identity, photos, matches and blocks on a new device, from any peer that has a copy of the network.'),
    h('p', { class: 'section-foot', style: 'margin:0' }, 'Your encrypted backup is stored in the shared database. Only the code can open it. Anyone with the code can become you.'))
  const dlg = sheet({ title: 'Recovery code', body, foot: [cancel, create] })
  create.onclick = () => busy(create, async () => {
    const { code } = await api('backup', {})
    const copy = h('button', { class: 'btn', type: 'button', onclick: () => copyText(code, copy) }, icon('copy'), 'Copy')
    body.replaceChildren(
      h('p', { style: 'margin:0;font-weight:600' }, 'Write this down and keep it somewhere offline. It won’t be shown again.'),
      h('div', { class: 'group mono', style: 'padding:16px;font-size:17px;letter-spacing:.04em;word-spacing:.2em;user-select:all;overflow-wrap:anywhere' }, code),
      h('p', { class: 'section-foot', style: 'margin:0' }, 'To restore: datetorrent restore <code> --from <peer url>'))
    create.remove()
    cancel.textContent = 'Done'
    cancel.before(copy)
  }, 'Creating…')
}

async function copyText (text, btn) {
  try {
    await navigator.clipboard.writeText(text)
    snack('Copied')
    if (btn) { const old = [...btn.childNodes]; btn.replaceChildren(icon('check'), 'Copied'); setTimeout(() => btn.isConnected && btn.replaceChildren(...old), 1500) }
  } catch {
    snack('Couldn’t copy. Select the text and copy it manually.')
  }
}

// ------------------------------------------------------------------ network

async function renderNetwork () {
  const g = state.gittorrent
  main.append(pageHead('Network', 'Your database is a git repo. Peers copy yours and you copy theirs.'))
  const wrapper = h('div', { class: 'narrow' })
  main.append(wrapper)

  const copyRow = (ic, color, title, value, empty) => h('div', { class: 'row' },
    h('div', { class: 'icon-tile', style: `background:${color}` }, icon(ic)),
    h('div', { class: 'grow' }, h('div', { class: 'title' }, title), h('div', { class: 'sub mono' }, value || empty)),
    value && h('button', { class: 'icon-btn', type: 'button', 'aria-label': `Copy ${title}`, onclick: (e) => copyText(value, null) }, icon('copy')))

  wrapper.append(
    h('div', { class: 'section-title' }, 'This device'),
    h('div', { class: 'group' },
      copyRow('key', '#8e8e93', 'Your id', state.myId),
      copyRow('globe', '#0a84ff', 'Database address', g.dbUrl, 'Run “datetorrent serve” to publish on GitTorrent'),
      copyRow('server', '#5e5ce6', 'App address', g.appUrl, 'Published together with your database'),
      h('div', { class: 'row' },
        h('div', { class: 'icon-tile', style: `background:${g.gittorrentd ? '#1f8a4c' : '#b45309'}` }, icon(g.gittorrentd ? 'check' : 'info')),
        h('div', { class: 'grow' }, h('div', { class: 'title' }, 'GitTorrent'), h('div', { class: 'sub' }, g.gittorrentd ? 'Installed' : 'Not installed. Run: npm install --global gittorrent')))),
    h('p', { class: 'section-foot' }, `Data folder: ${state.home}`))

  const peersBox = h('div', { class: 'group' }, h('div', { class: 'row' }, h('div', { class: 'skeleton', style: 'height:14px;width:70%' })))
  const lastSync = remember('lastSync')
  const syncNote = h('p', { class: 'section-foot', role: 'status' }, lastSync || 'Not synced yet on this device.')
  const syncBtn = h('button', { class: 'btn primary block', type: 'button', onclick: () => busy(syncBtn, async () => {
    const s = await api('sync', {})
    const parts = [`${plural(s.profiles, 'profile')}`, `${plural(s.media, 'photo')}`, `${plural(s.mail, 'sealed message')}`]
    const note = `Last synced ${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}: ${parts.join(', ')} new` + (s.failed.length ? `. ${plural(s.failed.length, 'peer')} unreachable.` : '.')
    remember('lastSync', note)
    snack(s.failed.length ? `Synced, but ${plural(s.failed.length, 'peer')} couldn’t be reached` : 'Sync complete')
    render()
  }, 'Syncing…') }, icon('sync'), 'Sync now')

  const url = h('input', { id: 'peer-url', type: 'text', placeholder: 'gittorrent://<hash>/datetorrent-db', autocomplete: 'off', spellcheck: 'false', 'aria-describedby': 'peer-err' })
  const urlErr = h('div', { class: 'field-error', id: 'peer-err', role: 'alert' })
  const add = h('button', { class: 'btn', type: 'submit' }, icon('plus'), 'Add')
  const addForm = h('form', { class: 'row stack', onsubmit: (e) => {
    e.preventDefault()
    const v = url.value.trim()
    urlErr.textContent = ''
    if (!v) { urlErr.textContent = 'Paste a peer’s address first.'; url.focus(); return }
    if (!/^(gittorrent|git|https?|ssh):\/\/|^\/|^[\w.-]+@[\w.-]+:/.test(v)) { urlErr.textContent = 'That doesn’t look like a git address. Try gittorrent://…, https://…, or a folder path.'; url.setAttribute('aria-invalid', 'true'); return }
    busy(add, async () => { await api('peers', { url: v }); snack('Peer added. Sync to fetch their data.'); render() })
  } },
  h('label', { class: 'field-label', for: 'peer-url' }, 'Add a peer'),
  h('div', { style: 'display:flex;gap:8px' }, url, add), urlErr)

  wrapper.append(h('div', { class: 'section-title' }, 'Peers'), peersBox, h('div', { class: 'group', style: 'margin-top:12px' }, addForm),
    h('div', { style: 'margin-top:20px' }, syncBtn), syncNote)

  try {
    const peers = await api('peers')
    peersBox.replaceChildren(...(peers.length ? peers.map((p) => h('div', { class: 'row' },
      h('div', { class: 'icon-tile', style: 'background:#30b0c7' }, icon('network')),
      h('div', { class: 'grow' }, h('div', { class: 'title' }, p.name), h('div', { class: 'sub mono' }, p.url)),
      h('button', { class: 'btn danger small', type: 'button', onclick: (e) => busy(e.currentTarget, async () => {
        await api('peers/remove', { name: p.name })
        snack(`Removed ${p.name}`, { action: 'Undo', onAction: () => api('peers', { url: p.url, name: p.name }).then(render).catch((err) => snack(err.message)) })
        render()
      }) }, 'Remove')))
      : [h('div', { class: 'row' }, h('div', { class: 'grow sub' }, 'No peers yet. Paste a friend’s address below to join their network.'))]))
  } catch (e) {
    peersBox.replaceChildren(h('div', { class: 'row field-error' }, e.message))
  }
}

// ------------------------------------------------------------------ boot

$('#brand').prepend(brandMark())
render()
