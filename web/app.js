// Tabby Remote web client: a sidebar like tabby-groups' and one attached terminal pane.
const $ = id => document.getElementById(id)
const el = (tag, props = {}, ...kids) => {
    const e = Object.assign(document.createElement(tag), props)
    e.append(...kids.filter(k => k != null))
    return e
}

const KEYS = { esc: '\x1b', tab: '\t', ctrlc: '\x03', home: '\x1b[H', end: '\x1b[F', pgup: '\x1b[5~', pgdn: '\x1b[6~' }
const NO_COLOR = '#9aa0a6'
// tabby-groups' panel tints: less colour the deeper a panel sits, 6% more on the active row.
const tintPct = depth => Math.max(20 - depth * 3, 11)
const ACTIVE_TINT_ADD = 6
// Phone layout (sidebar over the terminal): narrow screens, and phones on their side, which are short.
const narrow = matchMedia('(max-width: 799px), (max-height: 500px)')
const touch = matchMedia('(pointer: coarse)')

let token = localStorage.getItem('tabby-remote-token')
let sessions = []
let groups = []
let icons = {}
// Remembered per device: the last tab opened and the terminal text size.
const saved = key => {
    try {
        return JSON.parse(localStorage.getItem('tabby-remote-' + key))
    } catch {
        return null
    }
}
const remember = (key, value) => {
    try {
        localStorage.setItem('tabby-remote-' + key, JSON.stringify(value))
    } catch { }
}
let current = null // { sessionId, paneId }
let me = null // this device: { id, name, color }
let hasGroups = true // tabby-groups is installed in Tabby
let socket = null
let term = null
let events = null

const api = (path, opts = {}) => fetch(path, { ...opts, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` } })

// ---- Sign in ----

function deviceName () {
    const ua = navigator.userAgent
    return /iPhone|iPad|Android/.exec(ua)?.[0] ?? (/Mac OS X|Macintosh/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /Linux|CrOS/.test(ua) ? 'Linux' : 'Browser')
}

function signedIn (t) {
    token = t
    localStorage.setItem('tabby-remote-token', t)
    $('signin').hidden = true
    start()
}

function signOut (msg) {
    token = null
    localStorage.removeItem('tabby-remote-token')
    // Detach first, so their close handlers do not reconnect and wipe the message below.
    const [e, s] = [events, socket]
    events = socket = null
    e?.close()
    s?.close()
    $('signin-err').textContent = msg ?? ''
    $('signin').hidden = false
    // The password row only shows when Tabby has a password set.
    fetch('/api/info').then(r => r.json()).then(i => {
        document.querySelector('.or').hidden = $('pw-form').hidden = !i.password
    }).catch(() => {})
}

async function pairWith (code) {
    const r = await fetch('/api/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, deviceName: deviceName() }) })
    if (r.ok) return signedIn((await r.json()).token)
    // An old QR link must not undo a sign-in this browser already has.
    if (token) return start()
    signOut(r.status === 429 ? 'Too many tries. Wait 1 min.' : 'Code expired. Use the new one in Tabby.')
}

async function tryPair () {
    const code = /pair=(\d{6})/.exec(location.hash)?.[1]
    if (!code) return false
    history.replaceState(null, '', location.pathname)
    await pairWith(code)
    return true
}

// Six one-digit boxes: typing moves on, Backspace moves back, a pasted or autofilled code spreads over them.
const boxes = Array.from({ length: 6 }, (_, i) => el('input', {
    inputMode: 'numeric',
    autocomplete: i === 0 ? 'one-time-code' : 'off',
    ariaLabel: `Digit ${i + 1}`,
    maxLength: 6,
}))
$('code').append(...boxes)
const fillFrom = (i, digits) => {
    for (const d of digits) {
        if (i > 5) break
        boxes[i++].value = d
    }
    boxes[Math.min(i, 5)].focus()
    const code = boxes.map(b => b.value).join('')
    if (/^\d{6}$/.test(code)) {
        boxes.forEach(b => { b.value = '' })
        pairWith(code)
    }
}
boxes.forEach((b, i) => {
    b.addEventListener('input', () => {
        const digits = b.value.replace(/\D/g, '')
        b.value = ''
        if (digits) fillFrom(i, digits)
    })
    b.addEventListener('keydown', e => {
        if (e.key === 'Backspace' && !b.value && i > 0) {
            boxes[i - 1].value = ''
            boxes[i - 1].focus()
            e.preventDefault()
        }
        if (e.key === 'ArrowLeft' && i > 0) boxes[i - 1].focus()
        if (e.key === 'ArrowRight' && i < 5) boxes[i + 1].focus()
    })
    b.addEventListener('focus', () => b.select())
})
$('code-form').onsubmit = e => e.preventDefault()

// ---- Pair by photo: show the QR on the PC, take one photo of it, read the code from the photo ----
// (A live camera needs https, which a page on the Wi-Fi does not have; a photo from the phone's camera works.)

const requestQr = () => fetch('/api/qr', { method: 'POST' }).catch(() => null)

let jsqrLoaded = null
const loadJsQr = () => (jsqrLoaded ??= new Promise((resolve, reject) => {
    document.head.append(el('script', { src: 'jsqr.js', onload: resolve, onerror: reject }))
}))

/** The pairing code in a photo of the QR, or null. */
async function codeFromPhoto (file) {
    await loadJsQr()
    const img = await createImageBitmap(file)
    // Large enough to read a QR across a room, small enough to be quick.
    const scale = Math.min(1, 1600 / Math.max(img.width, img.height))
    const w = Math.round(img.width * scale)
    const h = Math.round(img.height * scale)
    const canvas = el('canvas', { width: w, height: h })
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    ctx.drawImage(img, 0, 0, w, h)
    const found = window.jsQR(ctx.getImageData(0, 0, w, h).data, w, h)
    return /pair=(\d{6})/.exec(found?.data ?? '')?.[1] ?? null
}

$('scan-btn').onclick = () => {
    // The camera must open from the tap itself; the QR appears on the PC while it does.
    $('scan-pick').click()
    requestQr()
}
$('scan-pick').addEventListener('change', async () => {
    const file = $('scan-pick').files[0]
    $('scan-pick').value = ''
    if (!file) return
    $('signin-err').textContent = 'Reading the code…'
    const code = await codeFromPhoto(file).catch(() => null)
    if (!code) {
        $('signin-err').textContent = 'No QR found in the photo. Try again, a little closer.'
        return
    }
    $('signin-err').textContent = ''
    pairWith(code)
})

$('pw-show').onclick = () => {
    const show = $('pw').type === 'password'
    $('pw').type = show ? 'text' : 'password'
    $('pw-show').textContent = show ? 'Hide' : 'Show'
    $('pw-show').ariaPressed = String(show)
}

$('pw-form').onsubmit = async e => {
    e.preventDefault()
    const r = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: $('pw').value, deviceName: deviceName() }) })
    if (!r.ok) {
        $('signin-err').textContent = r.status === 429 ? 'Too many tries. Wait 1 min.' : 'Wrong password'
        return
    }
    signedIn((await r.json()).token)
}

// ---- Data ----

async function start () {
    let s, g, i
    try {
        [s, g, i] = await Promise.all(['/api/sessions', '/api/groups', '/api/icons'].map(p => api(p)))
    } catch {
        // Tabby is restarting: keep the sign-in and try again.
        return setTimeout(start, 2000)
    }
    if (s.status === 401) return signOut()
    sessions = await s.json()
    groups = await g.json()
    icons = await i.json()
    // Which device this page is, so its own badge is left out (its tab is already highlighted).
    me = (await (await api('/api/devices')).json().catch(() => [])).find?.(d => d.current) ?? me
    // Without tabby-groups there are no groups, pins or drag and drop: those controls stay hidden.
    hasGroups = (await (await fetch('/api/info')).json().catch(() => ({}))).groups !== false
    renderTree()
    listen()
    if (current && socket?.readyState === WebSocket.OPEN) return
    // Also after a Tabby restart. Tab ids change then, so the last tab is found again by its title.
    const last = saved('last')
    const again = last && (sessions.find(x => x.id === last.sessionId) ?? sessions.find(x => x.title === last.title))
    const first = again ?? (narrow.matches ? null : sessions.find(x => x.active) ?? sessions[0])
    if (first) open(first.id, again && last.paneId)
    else setView('list')
    // Wide screens show the list all the time: bring the open tab into view once.
    if (!narrow.matches) requestAnimationFrame(revealCurrent)
}

function listen () {
    events?.close()
    const ws = events = new WebSocket(`ws://${location.host}/api/events`)
    ws.onopen = () => ws.send(JSON.stringify({ type: 'auth', token }))
    ws.onmessage = e => {
        const m = JSON.parse(e.data)
        // + already listed the tab it opened; the event for it only refreshes that entry.
        if (m.type === 'opened') sessions = [...sessions.filter(s => s.id !== m.session.id), m.session]
        else if (m.type === 'changed') {
            const before = sessions.find(s => s.id === m.session.id)
            sessions = sessions.map(s => s.id === m.session.id ? m.session : s)
            watchAgents(before, m.session)
        }
        else if (m.type === 'closed') sessions = sessions.filter(s => s.id !== m.id)
        else if (m.type === 'groups') groups = m.groups
        queueRender()
        if (current && m.session?.id === current.sessionId) renderHead()
    }
    ws.onclose = e => {
        if (e.code === 4001) return signOut('Signed out')
        if (events === ws) setTimeout(() => token && start(), 2000)
    }
}

// ---- Sidebar ----

function iconFor (kind, size = 16) {
    const i = icons[kind]
    const ns = 'http://www.w3.org/2000/svg'
    const svg = document.createElementNS(ns, 'svg')
    svg.setAttribute('viewBox', '0 0 24 24')
    svg.setAttribute('width', size)
    svg.setAttribute('height', size)
    svg.setAttribute('aria-hidden', 'true')
    // Unknown kinds get a plain prompt glyph.
    const paths = i ? (i.paths ?? [i.path]) : ['M4 17l6-5-6-5', 'M12 19h8']
    const stroke = !i || i.stroke
    for (const d of paths) {
        const p = document.createElementNS(ns, 'path')
        p.setAttribute('d', d)
        if (stroke) {
            p.setAttribute('fill', 'none')
            p.setAttribute('stroke', i?.color ?? '#bbb')
            p.setAttribute('stroke-width', '2')
            p.setAttribute('stroke-linecap', 'round')
            p.setAttribute('stroke-linejoin', 'round')
        } else {
            p.setAttribute('fill', i.color)
        }
        svg.appendChild(p)
    }
    return svg
}

// Font Awesome 'thumbtack' (CC BY 4.0), the glyph Tabby uses for a pinned tab.
const PIN = 'M32 32C32 14.3 46.3 0 64 0H320c17.7 0 32 14.3 32 32s-14.3 32-32 32H290.5l11.4 148.2c36.7 19.9 65.7 53.2 79.5 94.7l1 3c3.3 9.8 1.6 20.5-4.4 28.8s-15.7 13.3-26 13.3H32c-10.3 0-19.9-4.9-26-13.3s-7.7-19.1-4.4-28.8l1-3c13.8-41.5 42.8-74.8 79.5-94.7L93.5 64H64C46.3 64 32 49.7 32 32zM160 384h64v96c0 17.7-14.3 32-32 32s-32-14.3-32-32V384z'

function pinIcon () {
    const ns = 'http://www.w3.org/2000/svg'
    const svg = document.createElementNS(ns, 'svg')
    svg.setAttribute('viewBox', '0 0 384 512')
    svg.setAttribute('width', 10)
    svg.setAttribute('height', 12)
    const p = document.createElementNS(ns, 'path')
    p.setAttribute('d', PIN)
    p.setAttribute('fill', 'currentColor')
    svg.appendChild(p)
    return svg
}

/** `color`/`depth` are the panel the row sits in, so the active row can take tabby-groups' stronger tint. */
function row (s, color, depth) {
    const r = el('button', {
        // Claude's state, as tabby-groups draws it: a spinning ring on the icon while busy; a dot and a bold title
        // when it finished while nobody was looking ("needs you").
        className: 'row' + (s.cwd ? ' two-line' : '') + (s.agent?.needsYou ? ' needs-you' : '') + (s.agent?.state === 'busy' ? ' busy' : ''),
        ariaCurrent: String(current?.sessionId === s.id),
        title: [s.title, s.cwd].filter(Boolean).join('\n'),
        onclick: () => open(s.id),
    },
    el('span', { className: 'num', textContent: s.index }),
    s.pinned ? el('span', { className: 'pin', ariaLabel: 'pinned' }, pinIcon()) : null,
    // No icon for an app tabby-groups has none for.
    icons[s.kind] ? el('span', { className: 'icon' }, iconFor(s.kind, 14)) : null,
    el('span', { className: 'text' }, el('span', { className: 'title', textContent: s.title }), s.cwd ? el('span', { className: 'cwd', textContent: s.cwd }) : null),
    badges(s),
    // Mouse only (touch swipes the row away): Tabby's ✕ on hover.
    el('span', { className: 'close', role: 'button', ariaLabel: `Close ${s.title}`, title: 'Close tab', textContent: '✕', onclick: e => { e.stopPropagation(); closeTab(s.id) } }))
    if (color) r.style.setProperty('--active-bg', `color-mix(in srgb, ${color} ${tintPct(depth) + ACTIVE_TINT_ADD}%, var(--bg))`)
    r.dataset.id = s.id
    return r
}

// ---- Presence: a badge per other device on each tab it has open (the same badges as in Tabby's sidebar) ----

const STATE_RANK = { typing: 0, watching: 1, away: 2 }
const STATE_WORD = { typing: 'typing', watching: 'watching', away: 'away' }

/** One device badge: its initial in its colour; typing pulses, away is dimmed. */
function badge (v) {
    return el('span', {
        className: `badge ${v.state}`,
        textContent: (v.name || '?')[0].toUpperCase(),
        title: `${v.name} · ${STATE_WORD[v.state]}${v.sizer ? ' · sets the size' : ''}`,
        style: `--c:${v.color}`,
    })
}

/** The other devices on this tab, at most 3 then "+N", and a monitor for the tab active on the PC. */
function badges (s, withPc = true) {
    const others = (s.viewers ?? []).filter(v => v.id !== me?.id).sort((a, b) => STATE_RANK[a.state] - STATE_RANK[b.state])
    const pc = withPc && s.active ? el('span', { className: 'badge pc', title: 'Active in Tabby on the PC' }, monitorIcon()) : null
    if (!others.length && !pc) return null
    return el('span', { className: 'badges' }, pc, ...others.slice(0, 3).map(badge), others.length > 3 ? el('span', { className: 'badge-more', textContent: `+${others.length - 3}` }) : null)
}

/** Lucide 'monitor' (ISC). */
function monitorIcon () {
    const ns = 'http://www.w3.org/2000/svg'
    const svg = document.createElementNS(ns, 'svg')
    for (const [k, v] of Object.entries({ viewBox: '0 0 24 24', width: 10, height: 10, fill: 'none', stroke: 'currentColor', 'stroke-width': 2.5, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' })) svg.setAttribute(k, v)
    for (const d of ['M2 3h20v14H2z', 'M8 21h8', 'M12 17v4']) {
        const p = document.createElementNS(ns, 'path')
        p.setAttribute('d', d)
        svg.appendChild(p)
    }
    return svg
}

/**
 * Search as tabby-groups does: case-insensitive, split into words, and every word must match the title, a group on
 * its path, the folder, the app (key or label), or, for a number with or without '#', the tab's number.
 */
function matches (s, query) {
    const hay = [s.title, ...s.group, s.cwd, s.kind, icons[s.kind]?.label].filter(Boolean).join('\n').toLowerCase()
    return query.split(/\s+/).every(w => hay.includes(w) || (/^#?\d+$/.test(w) && String(s.index) === w.replace('#', '')))
}

/** Groups nest by `parent`; tabs sit in their innermost group. Everything keeps Tabby's tab order. */
function tree (keep = () => true) {
    const nodes = new Map(groups.map(g => [g.name, { group: g, kids: [], first: Infinity, count: 0 }]))
    const top = []
    for (const s of [...sessions].filter(keep).sort((a, b) => a.index - b.index)) {
        const g = nodes.get(s.group.at(-1))
        ;(g ? g.kids : top).push({ tab: s, first: s.index })
    }
    for (const n of nodes.values()) {
        const p = nodes.get(n.group.parent)
        ;(p ? p.kids : top).push(n)
    }
    const settle = n => {
        if (n.tab) return
        n.kids.forEach(settle)
        n.kids = n.kids.filter(k => k.tab || k.count > 0).sort((a, b) => a.first - b.first)
        n.first = Math.min(Infinity, ...n.kids.map(k => k.first))
        n.count = n.kids.reduce((c, k) => c + (k.tab ? 1 : k.count), 0)
    }
    const root = { kids: top }
    settle(root)
    return root.kids
}

/** Lucide 'chevron-right' (ISC, lucide.dev); it turns to point down when the group is open. Shared with tabby-groups. */
function chevron () {
    const ns = 'http://www.w3.org/2000/svg'
    const svg = document.createElementNS(ns, 'svg')
    for (const [k, v] of Object.entries({ viewBox: '0 0 24 24', width: 12, height: 12, fill: 'none', stroke: 'currentColor', 'stroke-width': 2.5, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) svg.setAttribute(k, v)
    const p = document.createElementNS(ns, 'path')
    p.setAttribute('d', 'm9 18 6-6-6-6')
    svg.appendChild(p)
    return svg
}

function groupEl (n, depth, hiddenAbove = false) {
    const g = n.group
    const shut = isShut(g)
    const color = g.color ?? NO_COLOR
    const box = el('div', { className: 'grp' + (depth === 0 ? ' top' : '') })
    box.dataset.group = g.name
    box.style.background = `color-mix(in srgb, ${color} ${tintPct(depth)}%, var(--bg))`
    box.append(el('div', { className: 'grp-bar' },
        el('button', {
            className: 'grp-head',
            ariaExpanded: String(!shut),
            // As in tabby-groups: a click folds after 220 ms, so a double-click (rename) can cancel it.
            onclick: e => {
                if (e.detail > 1) return
                const head = e.currentTarget
                clearTimeout(pendingFold)
                pendingFold = setTimeout(() => foldGroup(g.name, !(shut || hiddenAbove), head), 220)
            },
            ondblclick: e => {
                clearTimeout(pendingFold)
                if (e.target.closest('.name')) renameGroup(g.name)
            },
        },
        // A subgroup inside a collapsed parent is drawn collapsed too, as in tabby-groups.
        el('span', { className: 'caret' + (shut || hiddenAbove ? '' : ' open') }, chevron()),
        el('span', { className: 'name', textContent: g.name }),
        el('span', { className: 'count' }, `${n.count} tab${n.count === 1 ? '' : 's'}`, rollup(g))),
        g.pinned ? el('span', { className: 'grp-pin', ariaLabel: 'pinned group', title: 'Pinned group' }, pinIcon()) : null,
        el('button', { className: 'icon-btn grp-add', textContent: '+', ariaLabel: `New tab in ${g.name}`, title: `New tab in ${g.name}`, onclick: () => newTab(g.name) })))
    box.querySelector('.grp-head').title = g.name
    // Collapsed (itself or a parent), it shows only the open tab and the subgroups on the way to it,
    // as tabby-groups shows the active tab. While searching, collapse is ignored.
    const hide = !searching() && (shut || hiddenAbove)
    const holds = k => k.tab ? k.tab.id === current?.sessionId : k.kids.some(holds)
    const kids = hide ? n.kids.filter(holds) : n.kids
    kids.forEach(k => box.append(k.tab ? row(k.tab, color, depth) : groupEl(k, depth + 1, hide)))
    box.classList.toggle('empty', !kids.length)
    return box
}

const searching = () => !!$('search').value.trim()

/**
 * tabby-groups' roll-up for the whole subtree: " · 1 needs you · 2 busy", so a folded group still says something
 * finished. Tapping it opens the first tab in the group that needs you.
 */
function rollup (g) {
    const parts = [g.needsYou ? `${g.needsYou} need${g.needsYou === 1 ? 's' : ''} you` : null, g.busy ? `${g.busy} busy` : null].filter(Boolean)
    if (!parts.length) return null
    return el('span', {
        className: 'rollup',
        textContent: ' · ' + parts.join(' · '),
        onclick: e => {
            const first = sessions.filter(s => s.agent?.needsYou && s.group.includes(g.name)).sort((a, b) => a.index - b.index)[0]
            if (!first) return
            e.stopPropagation()
            clearTimeout(pendingFold)
            open(first.id)
        },
    })
}

// ---- "Needs you": a notice when a Claude finishes on a tab this page is not showing ----

let toastTimer = 0
function toast (text, onTap) {
    const t = $('toast')
    t.textContent = text
    t.onclick = () => { t.hidden = true; onTap?.() }
    t.hidden = false
    navigator.vibrate?.(30)
    clearTimeout(toastTimer)
    toastTimer = setTimeout(() => { t.hidden = true }, 6000)
}

/** Called with each changed session: a notice when it newly needs you. */
function watchAgents (before, after) {
    if (after?.agent?.needsYou && !before?.agent?.needsYou && after.id !== current?.sessionId) {
        toast(`${after.title} needs you`, () => open(after.id))
    }
}

/** How many tabs need you: a badge on ☰ (the title is not shown full screen from the Home Screen) and in the title. */
function showNeedsYou () {
    const n = sessions.filter(s => s.agent?.needsYou).length
    document.title = n ? `(${n}) Tabby Remote` : 'Tabby Remote'
    $('list-badge').hidden = !n
    $('list-badge').textContent = n > 9 ? '9+' : n
    $('show-list').ariaLabel = n ? `Show tabs, ${n} need${n === 1 ? 's' : ''} you` : 'Show tabs'
}

/** One redraw per frame for a burst of events; none mid-drag, menu or swipe (as tabby-groups pauses), one after. */
let renderQueued = false
function queueRender () {
    if (renderQueued) return
    renderQueued = true
    requestAnimationFrame(function again () {
        if (drag || swipe || !$('menu').hidden) return requestAnimationFrame(again)
        renderQueued = false
        renderTree()
    })
}

/** The sidebar. While searching, only matching tabs show, still inside their groups (as in tabby-groups). */
function renderTree () {
    const q = $('search').value.trim().toLowerCase()
    const nodes = tree(q ? s => matches(s, q) : undefined)
    $('tree').replaceChildren(...nodes.map(n => n.tab ? row(n.tab) : groupEl(n, 0)))
    showNeedsYou()
}
$('search').oninput = renderTree
// Enter opens the first match; Escape clears the search.
$('search').addEventListener('keydown', e => {
    if (e.key === 'Enter') $('tree').querySelector('.row')?.click()
    if (e.key === 'Escape') {
        $('search').value = ''
        $('search').blur()
        renderTree()
    }
})

// ---- Drag and drop in the sidebar, with tabby-groups' rules ----
// Touch: hold a row or group header ~0.4 s, then drag. Mouse: just drag. Where it lands follows tabby-groups:
// a tab's middle groups with it ("onto"), its top or bottom quarter goes before or after it (halves when a group is
// dragged, or the tab is alone in its group); a group header's halves are "above" and "first in the group"; the gap
// under a group's last row is "last in it" / "below it". Tabby applies the drop (POST /api/move), and the list
// updates from Tabby's events.

const dropLine = el('div', { className: 'drop-line' })
const ghost = el('div', { className: 'drag-ghost' })
let drag = null // { source: { session } | { group }, label, el }

const parentOf = name => groups.find(g => g.name === name)?.parent ?? null
/** The group and all its ancestors. */
const chainOf = name => {
    const out = []
    for (let n = name; n && out.length <= groups.length; n = parentOf(n)) out.push(n)
    return out
}

function intentAt (x, y) {
    const src = drag.source
    for (const hit of document.elementsFromPoint(x, y)) {
        if (!hit.closest('#tree')) continue
        const row = hit.closest('.row')
        if (row) {
            const s = sessions.find(v => v.id === row.dataset.id)
            if (!s || s.id === src.session) return null
            // A dragged group cannot land among its own rows.
            if (src.group && s.group.includes(src.group)) return null
            const inner = s.group.at(-1)
            const lone = inner && !sessions.some(v => v.id !== s.id && v.id !== src.session && v.group.at(-1) === inner)
            const r = row.getBoundingClientRect()
            const f = (y - r.top) / r.height
            const where = src.group || lone ? (f < 0.5 ? 'before' : 'after') : f < 0.25 ? 'before' : f > 0.75 ? 'after' : 'onto'
            return { el: row, target: { session: s.id }, where }
        }
        const bar = hit.closest('.grp-bar')
        const box = hit.closest('.grp')
        if (!box) continue
        const name = box.dataset.group
        if (src.group && chainOf(name).includes(src.group)) return null
        if (bar) {
            const r = bar.getBoundingClientRect()
            return { el: bar, target: { group: name }, where: (y - r.top) / r.height < 0.5 ? 'above' : 'first' }
        }
        // The gap under the group's last row.
        const r = box.getBoundingClientRect()
        return { el: box, target: { group: name }, where: y > r.bottom - 3 ? 'below' : 'last' }
    }
    return null
}

function showMark (i) {
    document.querySelectorAll('.drop-onto').forEach(e => e.classList.remove('drop-onto'))
    if (!i || i.where === 'onto') {
        dropLine.remove()
        i?.el.classList.add('drop-onto')
        return
    }
    const r = i.el.getBoundingClientRect()
    // "last" sits above the group's bottom gap, at its last row; "below" under the whole group.
    const top = i.where === 'last' ? r.bottom - 6 : ['after', 'first', 'below'].includes(i.where) ? r.bottom : r.top
    Object.assign(dropLine.style, { left: `${r.left + 6}px`, width: `${r.width - 12}px`, top: `${top - 1}px` })
    document.body.append(dropLine)
}

let edgeScroll = 0
function dragMove (x, y) {
    Object.assign(ghost.style, { left: `${x + 12}px`, top: `${y + 8}px` })
    if (drag.cancelled) return
    drag.intent = intentAt(x, y)
    showMark(drag.intent)
    // Near the top or bottom of the list, it scrolls.
    const t = $('tree').getBoundingClientRect()
    const speed = y < t.top + 40 ? -8 : y > t.bottom - 40 ? 8 : 0
    cancelAnimationFrame(edgeScroll)
    if (speed) {
        const step = () => {
            $('tree').scrollTop += speed
            drag && (edgeScroll = requestAnimationFrame(step))
        }
        edgeScroll = requestAnimationFrame(step)
    }
}

async function dragEnd (apply) {
    cancelAnimationFrame(edgeScroll)
    const d = drag
    drag = null
    ghost.remove()
    showMark(null)
    d.el.classList.remove('dragging')
    // The click that ends a drag must not also open the tab or fold the group.
    const swallow = e => e.stopPropagation()
    document.addEventListener('click', swallow, true)
    setTimeout(() => document.removeEventListener('click', swallow, true))
    if (!apply || !d.intent) return
    const r = await api('/api/move', { method: 'POST', body: JSON.stringify({ source: d.source, target: d.intent.target, where: d.intent.where }) })
    if (r.ok) return
    setStatus(r.status === 501 ? 'Drag needs the latest tabby-groups' : "Can't drop there")
    setTimeout(() => setStatus(null), 2000)
}

function dragStart (target, x, y) {
    const row = target.closest('.row')
    const bar = target.closest('.grp-bar')
    const source = row ? { session: row.dataset.id } : { group: bar.parentElement.dataset.group }
    drag = { source, el: row ?? bar, intent: null }
    drag.el.classList.add('dragging')
    ghost.textContent = row ? row.querySelector('.title').textContent : source.group
    document.body.append(ghost)
    dragMove(x, y)
}

/** Closes a tab in Tabby. A pinned tab is refused; `onRefused` lets a swiped row spring back. */
async function closeTab (id, onRefused) {
    const r = await api(`/api/sessions/${id}`, { method: 'DELETE' })
    if (r.status === 409) {
        onRefused?.()
        setStatus('Pinned: unpin it in Tabby to close')
        setTimeout(() => setStatus(null), 2500)
    }
}

// Swipe a row left to close its tab, as in iPhone lists: the red Close grows behind it; let go past a third of
// the row and the tab closes, otherwise it springs back.
let swipe = null // { row, x, dx }
function swipeMove (dx) {
    swipe.dx = Math.min(0, dx)
    swipe.row.style.setProperty('--swipe', `${swipe.dx}px`)
}
function swipeEnd () {
    const { row, dx } = swipe
    swipe = null
    $('tree').style.overflowY = ''
    const back = () => {
        row.classList.add('settling')
        row.style.setProperty('--swipe', '0px')
        setTimeout(() => row.classList.remove('swiping', 'settling'), 200)
    }
    if (-dx < row.offsetWidth / 3) return back()
    row.classList.add('settling')
    row.style.setProperty('--swipe', `${-row.offsetWidth}px`)
    closeTab(row.dataset.id, back)
}

{
    const tree = $('tree')
    let press = null // { timer, x, y, target, mouse }
    tree.addEventListener('pointerdown', e => {
        const target = e.target.closest('.row, .grp-head')
        if (!target || e.target.closest('.grp-add') || e.button !== 0) return
        press = { x: e.clientX, y: e.clientY, target, mouse: e.pointerType === 'mouse' }
        // Touch, the iPhone way: hold, then let go for the menu, or move to drag. A quick swipe still scrolls.
        if (!press.mouse) {
            press.timer = setTimeout(() => {
                if (!press) return
                press.held = true
                press.target.classList.add('held')
                navigator.vibrate?.(10)
            }, 400)
        }
    })
    tree.addEventListener('pointermove', e => {
        if (drag) return dragMove(e.clientX, e.clientY)
        if (swipe) return swipeMove(e.clientX - swipe.x)
        if (!press) return
        const dx = e.clientX - press.x
        const dy = e.clientY - press.y
        const moved = Math.hypot(dx, dy)
        // Without tabby-groups there is nowhere to drop, so a hold and move does not start a drag.
        if (press.held && moved > 8) {
            press.target.classList.remove('held')
            if (hasGroups) dragStart(press.target, e.clientX, e.clientY)
            press = null
        } else if (press.mouse && moved > 5) {
            if (hasGroups) dragStart(press.target, e.clientX, e.clientY)
            else press = null
        }
        else if (!press.mouse && moved > 8) {
            clearTimeout(press.timer)
            // Mostly sideways on a tab row: a swipe; anything else: the list scrolls.
            const row = press.target.closest('.row')
            if (row && dx < 0 && Math.abs(dx) > Math.abs(dy) * 1.5) {
                swipe = { row, x: press.x, dx: 0 }
                row.classList.add('swiping')
                // Once it is a swipe, the list holds still until the finger lifts.
                tree.style.overflowY = 'hidden'
                swipeMove(dx)
            }
            press = null
        }
    })
    const up = e => {
        clearTimeout(press?.timer)
        const held = press?.held && e.type === 'pointerup' ? press.target : null
        held?.classList.remove('held')
        press = null
        if (held) {
            // Held and let go without moving: the menu, and no click on the row or header.
            const swallow = ev => ev.stopPropagation()
            document.addEventListener('click', swallow, true)
            setTimeout(() => document.removeEventListener('click', swallow, true))
            openMenuFor(held)
        }
        if (drag) dragEnd(e.type === 'pointerup')
        if (swipe) {
            // A swipe ends without a click on the row.
            const swallow = ev => ev.stopPropagation()
            document.addEventListener('click', swallow, true)
            setTimeout(() => document.removeEventListener('click', swallow, true))
            swipeEnd()
        }
    }
    tree.addEventListener('pointerup', up)
    tree.addEventListener('pointercancel', up)
    // While held, dragging or swiping by touch, the finger moves the tab, not the list.
    tree.addEventListener('touchmove', e => (drag || swipe || press?.held) && e.preventDefault(), { passive: false })
    // With a mouse: right-click for the menu.
    tree.addEventListener('contextmenu', e => {
        const target = e.target.closest('.row, .grp-head')
        if (!target) return
        e.preventDefault()
        openMenuFor(target, e.clientX, e.clientY)
    })
    // With a mouse, as in tabby-groups: double-click a tab to rename it; double-click free space for a new tab in
    // the group under the pointer (or outside every group). Double-clicking a group name renames it (see groupEl).
    tree.addEventListener('dblclick', e => {
        if (e.target.closest('.grp-add, .grp-head')) return
        const rowEl = e.target.closest('.row')
        if (rowEl) return renameTab(sessions.find(s => s.id === rowEl.dataset.id))
        newTab(e.target.closest('.grp')?.dataset.group ?? null)
    })
    // Escape clears the drop target, as in tabby-groups: letting go then does nothing.
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape' && drag) {
            drag.cancelled = true
            drag.intent = null
            showMark(null)
        }
    })
}

// ---- Group and tab actions, applied in Tabby by tabby-groups (the same as its own menus) ----

const PALETTE = [['No color', null], ['Red', '#f2756a'], ['Green', '#8ef58a'], ['Yellow', '#fdffad'], ['Blue', '#86b7f7'], ['Magenta', '#f48cf6'], ['Lavender', '#d7cff9']]
let pendingFold = 0

const groupApi = (name, body) => api(`/api/groups/${encodeURIComponent(name)}`, { method: 'PATCH', body: JSON.stringify(body) })
const tabApi = (id, body) => api(`/api/sessions/${id}`, { method: 'PATCH', body: JSON.stringify(body) })

/**
 * Which groups are collapsed: Tabby's (tabby-groups), so folding on either side shows on both; or, when this
 * device keeps its own (⚙ in the sidebar), this device's, remembered here. A group new to this device starts open.
 */
let foldMode = saved('foldMode') ?? 'tabby'
let ownFolds = saved('folds') ?? {}
const isShut = g => foldMode === 'device' ? !!ownFolds[g.name] : !!g.collapsed

/** Folds or opens a group. Opening also opens its parents (tabby-groups' rule); shown at once here. */
function foldGroup (name, fold, head) {
    head?.querySelector('.caret')?.classList.toggle('open', !fold)
    const names = fold ? [name] : [name, ...chainOf(name)]
    if (foldMode === 'device') {
        for (const n of names) ownFolds[n] = fold
        remember('folds', ownFolds)
        return setTimeout(renderTree, 150)
    }
    for (const n of names) {
        const g = groups.find(x => x.name === n)
        if (g) g.collapsed = fold
    }
    setTimeout(renderTree, 150)
    groupApi(name, { collapsed: fold })
}

/** This device's settings, as a menu: for now, whose collapsed groups the sidebar shows. */
function settingsMenu () {
    const pick = mode => {
        // Switching to this device's own starts from what is shown now.
        if (mode === 'device' && foldMode !== 'device') ownFolds = Object.fromEntries(groups.map(g => [g.name, !!g.collapsed]))
        foldMode = mode
        remember('foldMode', mode)
        remember('folds', ownFolds)
        renderTree()
    }
    const r = $('settings').getBoundingClientRect()
    showMenu([
        { label: 'Collapsed groups' },
        { text: 'Synced with Tabby', checked: foldMode === 'tabby', run: () => pick('tabby') },
        { text: 'This device only', checked: foldMode === 'device', run: () => pick('device') },
    ], r.left, r.bottom)
}
$('settings').onclick = settingsMenu

/** "Group N", the first free N from the group count up, as tabby-groups names new groups. */
function newGroupName () {
    let n = groups.length + 1
    while (groups.some(g => g.name === `Group ${n}`)) n++
    return `Group ${n}`
}

async function renameGroup (name) {
    const value = await prompt2('Rename group', name)
    if (value == null || !value.trim() || value === name) return
    const r = await groupApi(name, { name: value.trim() })
    if (!r.ok) flash('That name is taken')
}

async function renameTab (s) {
    const value = await prompt2('Rename tab', s.title)
    // Empty clears the custom title, so the shell's own title shows again.
    if (value != null && value !== s.title) tabApi(s.id, { title: value.trim() })
}

function flash (text) {
    setStatus(text)
    setTimeout(() => setStatus(null), 2000)
}

/** Groups in tree order with their depth, for the "Move into" and "Add to group" lists. */
function groupTree () {
    const out = []
    const walk = (parent, depth) => groups.filter(g => (g.parent ?? null) === parent).forEach(g => {
        out.push({ g, depth })
        walk(g.name, depth + 1)
    })
    walk(null, 0)
    return out
}

// ---- The menu: an action sheet on phones, a popover at the pointer with a mouse ----

function showMenu (items, x, y) {
    const box = $('menu-card')
    box.replaceChildren(...items.map(it => {
        if (it.swatches) {
            return el('div', { className: 'swatches' }, ...it.swatches.map(([label, color]) => el('button', {
                className: 'swatch' + (color ? '' : ' none') + (it.current === color ? ' on' : ''),
                title: label,
                ariaLabel: label,
                style: color ? `background:${color}` : '',
                onclick: () => { hideMenu(); it.pick(color) },
            })))
        }
        if (it.peek) {
            const pre = el('pre', { className: 'peek', textContent: '…' })
            // A server that cannot peek (an older one, until Tabby restarts) just shows no preview.
            api(`/api/sessions/${it.peek}/peek?lines=12`).then(r => r.ok ? r.json() : Promise.reject(r)).then(({ lines }) => {
                pre.textContent = lines.length ? lines.join('\n') : '(nothing on screen yet)'
                pre.scrollTop = pre.scrollHeight
            }).catch(() => pre.remove())
            return pre
        }
        if (it.sep) return el('div', { className: 'menu-sep' })
        if (it.label && !it.run) return el('div', { className: 'menu-label', textContent: it.label })
        return el('button', {
            className: 'menu-item' + (it.danger ? ' danger' : ''),
            style: it.depth ? `padding-left:${10 + it.depth * 14}px` : '',
            textContent: it.text + (it.checked ? ' ✓' : ''),
            onclick: () => { if (!it.keepOpen) hideMenu(); it.run() },
        })
    }))
    $('menu').hidden = false
    $('menu').classList.toggle('sheet', narrow.matches || x == null)
    if (!narrow.matches && x != null) {
        const r = box.getBoundingClientRect()
        box.style.left = `${Math.min(x, innerWidth - r.width - 4)}px`
        box.style.top = `${Math.min(y, innerHeight - r.height - 4)}px`
    } else {
        box.style.left = box.style.top = ''
    }
}
function hideMenu () {
    $('menu').hidden = true
}
$('menu').addEventListener('click', e => e.target === $('menu') && hideMenu())
document.addEventListener('keydown', e => e.key === 'Escape' && !$('menu').hidden && hideMenu())

function openMenuFor (target, x, y) {
    const rowEl = target.closest('.row')
    if (rowEl) tabMenu(rowEl.dataset.id, x, y)
    else groupMenu(target.closest('.grp').dataset.group, x, y)
}

/** tabby-groups' group menu: colour, rename, collapse, pin, move into, ungroup. */
function groupMenu (name, x, y) {
    const g = groups.find(v => v.name === name)
    if (!g) return
    const own = new Set(groupTree().filter(({ g: v }) => chainOf(v.name).includes(name)).map(({ g: v }) => v.name))
    const targets = groupTree().filter(({ g: v }) => !own.has(v.name))
    showMenu([
        { swatches: PALETTE, current: g.color ?? null, pick: color => groupApi(name, { color }) },
        { sep: true },
        { text: 'Rename', run: () => renameGroup(name) },
        { text: isShut(g) ? 'Expand' : 'Collapse', run: () => foldGroup(name, !isShut(g)) },
        { text: g.pinned ? 'Unpin group' : 'Pin group', run: () => groupApi(name, { pinned: !g.pinned }) },
        ...(g.parent || targets.length ? [{ text: 'Move into…', keepOpen: true, run: () => showMenu([
            { label: `Move "${name}" into` },
            { text: 'Top level', checked: !g.parent, run: () => groupApi(name, { parent: null }) },
            ...targets.map(({ g: v, depth }) => ({ text: v.name, depth: depth + 1, checked: g.parent === v.name, run: () => groupApi(name, { parent: v.name }) })),
        ], x, y) }] : []),
        { sep: true },
        { text: g.parent ? 'Ungroup (move up a level)' : 'Ungroup', run: () => api(`/api/groups/${encodeURIComponent(name)}/ungroup`, { method: 'POST' }) },
    ], x, y)
}

/** tabby-groups' tab menu (add to group, new group, new subgroup, remove), plus rename, pin and close. */
function tabMenu (id, x, y) {
    const s = sessions.find(v => v.id === id)
    if (!s) return
    const inner = s.group.at(-1)
    showMenu([
        // Peek: the tab's last lines above its actions, as an iPhone long-press shows a preview.
        { peek: id },
        { text: 'Rename', run: () => renameTab(s) },
        ...(hasGroups ? [{ text: s.pinned ? 'Unpin' : 'Pin', run: () => tabApi(id, { pinned: !s.pinned }) }] : []),
        ...(hasGroups ? [{ text: 'Add to group…', keepOpen: true, run: () => showMenu([
            { label: `Add "${s.title}" to` },
            ...groupTree().map(({ g, depth }) => ({ text: g.name, depth, checked: g.name === inner, run: () => g.name !== inner && tabApi(id, { group: g.name }) })),
            { sep: true },
            { text: 'New group', run: () => tabApi(id, { group: newGroupName() }) },
        ], x, y) }] : []),
        ...(inner ? [
            { text: `New subgroup of ${inner}`, run: () => tabApi(id, { group: newGroupName(), parent: inner }) },
            { text: 'Remove from group', run: () => tabApi(id, { group: null }) },
        ] : []),
        { sep: true },
        { text: 'Close tab', danger: true, run: () => closeTab(id) },
    ], x, y)
}

/** A one-line text box in the bottom sheet; resolves with the text, or null when closed. */
function prompt2 (title, value) {
    return new Promise(resolve => {
        const box = $('sheet-text')
        $('sheet').dataset.kind = 'prompt'
        $('sheet-title').textContent = title
        $('sheet-go').textContent = 'Save'
        $('sheet-extra').replaceChildren()
        box.readOnly = false
        box.value = value
        box.placeholder = ''
        $('sheet').hidden = false
        box.focus()
        box.select()
        promptDone = text => {
            promptDone = null
            $('sheet').hidden = true
            box.blur()
            resolve(text)
        }
    })
}
let promptDone = null

/** Opens a shell tab in Tabby (in `group`, or outside every group) and shows it here. */
async function newTab (group) {
    const r = await api('/api/sessions', { method: 'POST', body: JSON.stringify(group ? { group } : {}) })
    if (!r.ok) return setStatus('Could not open a tab')
    const s = await r.json()
    if (!sessions.some(x => x.id === s.id)) sessions.push(s)
    open(s.id)
}
$('new-tab').onclick = () => newTab(null)

// ---- Terminal ----

/** The pill under the header: "Reconnecting…" or "Tab closed"; null hides it. A fresh snapshot clears it. */
function setStatus (text) {
    $('status').textContent = text ?? ''
    $('status').hidden = !text
    // Amber while it retries, red when there is nothing to go back to.
    // Amber while something is under way ("Reconnecting…", "Uploading…"), red otherwise.
    $('status').dataset.kind = text?.endsWith('…') ? 'wait' : 'gone'
}

function setView (v) {
    $('app').dataset.view = v
    // ✕ only when there is a terminal to go back to.
    $('hide-list').hidden = !current
    if (v === 'list') requestAnimationFrame(revealCurrent)
}

/** Scrolls the sidebar so the open tab's row sits in the middle. Only the list scrolls, never the page. */
function revealCurrent () {
    const tree = $('tree')
    const row = tree.querySelector('.row[aria-current="true"]')
    if (!row) return
    const r = row.getBoundingClientRect()
    const t = tree.getBoundingClientRect()
    tree.scrollTop += r.top - t.top - (t.height - r.height) / 2
}
$('show-list').onclick = () => setView('list')
$('hide-list').onclick = () => setView('term')

/**
 * On phones, swipe the sidebar open and shut: right to left on the terminal opens it (it slides in from the
 * right), left to right on the sidebar closes it. A quick, mostly sideways swipe only, so scrolling, the cursor
 * slide and swiping a tab row away (leftwards, inside the list) keep their own gestures.
 */
function sideSwipe (area, dir, act, anyWidth = false) {
    let start = null
    area.addEventListener('touchstart', e => {
        start = e.touches.length === 1 ? { x: e.touches[0].clientX, y: e.touches[0].clientY, t: e.timeStamp } : null
    }, { passive: true })
    area.addEventListener('touchend', e => {
        if (!start || !(narrow.matches || anyWidth)) return
        const p = e.changedTouches[0]
        const dx = p.clientX - start.x
        const dy = p.clientY - start.y
        const quick = e.timeStamp - start.t < 600
        const sliding = area.querySelector('.scroller')?.dataset.sliding
        start = null
        if (quick && !sliding && !drag && !swipe && dx * dir > 60 && Math.abs(dx) > Math.abs(dy) * 2) act()
    }, { passive: true })
}
sideSwipe($('term-box'), -1, () => setView('list'))
sideSwipe($('side'), 1, () => current && setView('term'))
// Swipe right on the terminal: accept the grey suggestion (on tablets too).
sideSwipe($('term-box'), 1, () => acceptSuggestion(), true)

/**
 * Accepts the grey suggestion after what is typed (PowerShell's prediction, Claude's suggested prompt): → to the end
 * of the typed text, then one more →, which accepts it in both. Without a suggestion it does nothing.
 */
function acceptSuggestion () {
    const t = term
    if (!t || !touch.matches) return
    const b = t.buffer.active
    const typed = typedAhead(t)
    // The grey text right after it (it may start with a space) must hold something.
    let found = false
    for (let at = b.cursorX + typed; at < b.cursorX + typed + t.cols && !found; at++) {
        const c = b.getLine(b.baseY + b.cursorY + Math.floor(at / t.cols))?.getCell(at % t.cols)
        if (!c?.isDim()) break
        found = !!c.getChars().trim()
    }
    if (found) sendKey(keySeq('right').repeat(typed + 1))
}

function renderHead () {
    const s = sessions.find(x => x.id === current?.sessionId)
    if (!s) return
    $('term-title').textContent = s.title
    $('term-icon').replaceChildren(iconFor(s.kind, 18))
    // Who else is on this terminal, and whose screen size it is using when that is not this device.
    const sizer = (s.viewers ?? []).find(v => v.sizer && v.id !== me?.id)
    $('present').replaceChildren(...[badges(s, false), sizer ? el('span', { className: 'sized', textContent: `Sized for ${sizer.name}` }) : null].filter(Boolean))
    $('panes').replaceChildren(...(s.panes.length > 1 ? s.panes.map((p, i) => el('button', {
        ariaPressed: String(p.id === current.paneId),
        title: p.cwd ?? '',
        onclick: () => open(s.id, p.id),
    }, iconFor(p.kind, 14), String(i + 1))) : []))
}

function open (sessionId, paneId) {
    const s = sessions.find(x => x.id === sessionId)
    if (!s) return
    $('copy-chip').hidden = true
    if (!s.panes.some(p => p.id === paneId)) paneId = (s.panes.find(p => p.focused) ?? s.panes[0]).id
    // The tab already open: just close the sidebar and carry on.
    if (current?.sessionId === sessionId && current.paneId === paneId && socket?.readyState === WebSocket.OPEN) return setView('term')
    current = { sessionId, paneId }
    remember('last', { sessionId, paneId, title: s.title })
    setView('term')
    renderHead()
    renderTree()

    socket?.close()
    term?.dispose()
    const box = el('div', { style: 'height:100%' })
    $('term-box').replaceChildren(box)
    term = new Terminal({
        scrollback: 10000,
        fontSize: saved('fontSize') ?? (narrow.matches ? 12 : 13),
        fontFamily: 'Menlo, Consolas, "Cascadia Mono", monospace',
        theme: { background: '#000000' },
        // Search's match highlights use xterm's decorations.
        allowProposedApi: true,
    })
    const fit = new FitAddon.FitAddon()
    term.loadAddon(fit)
    term.open(box)
    // Tabby's own terminal answers the shell's queries; a second answer from here would land as typed input.
    term.parser.registerCsiHandler({ final: 'n' }, () => true)
    term.parser.registerCsiHandler({ final: 'c' }, () => true)
    term.parser.registerCsiHandler({ prefix: '>', final: 'c' }, () => true)
    term.parser.registerCsiHandler({ prefix: '?', final: 'h' }, params => params.includes(1004))
    for (const code of [10, 11, 12]) term.parser.registerOscHandler(code, data => data === '?')

    const ws = socket = new WebSocket(`ws://${location.host}/api/sessions/${sessionId}/panes/${paneId}/attach`)
    ws.binaryType = 'arraybuffer'
    const send = m => ws.readyState === 1 && ws.send(JSON.stringify(m))
    const t = term
    let exited = false
    ws.onopen = () => {
        send({ type: 'auth', token })
        send({ type: 'presence', state: document.hidden ? 'away' : 'here' })
    }
    ws.onmessage = e => {
        if (typeof e.data !== 'string') return t.write(new Uint8Array(e.data))
        const m = JSON.parse(e.data)
        if (m.type === 'snapshot' || m.type === 'theme') applyTheme(t, m.theme)
        if (m.type === 'snapshot') {
            setStatus(null)
            t.reset()
            t.resize(m.cols, m.rows)
            // Then take this screen's size: xterm rewraps the history, and the shell redraws for the new width.
            t.write(m.data, () => {
                fitSize()
                t.scrollToBottom()
            })
        } else if (m.type === 'size') {
            t.resize(m.cols, m.rows)
        } else if (m.type === 'exit') {
            exited = true
            setStatus('Tab closed')
        }
    }
    ws.onclose = e => {
        if (e.code === 4001) return signOut('Signed out')
        if (socket !== ws || exited) return
        setStatus('Reconnecting…')
        setTimeout(() => socket === ws && start(), 2000)
    }

    // The terminal always takes this screen's size, and follows rotation and the keyboard opening.
    // If you type in Tabby meanwhile, Tabby takes its size back until you type here again.
    let ready = false
    const fitSize = () => {
        ready = true
        let d = fit.proposeDimensions()
        // The fit addon keeps room for xterm's scrollbar, which touch screens never show (the page draws its own
        // thin one over the text): there, fill the whole width, so no gap of several characters is left on the right.
        const cell = t._core?._renderService?.dimensions?.css?.cell
        if (d && touch.matches && cell?.width) {
            d = { cols: Math.max(2, Math.floor(box.clientWidth / cell.width)), rows: Math.max(1, Math.floor(box.clientHeight / cell.height)) }
            // What is left (under one character) is split between both sides, so the text sits centred.
            t.element.style.transform = `translateX(${Math.max(0, (box.clientWidth - d.cols * cell.width) / 2)}px)`
        }
        if (d && (d.cols !== t.cols || d.rows !== t.rows)) {
            t.resize(d.cols, d.rows)
            send({ type: 'resize', cols: d.cols, rows: d.rows })
        }
    }
    t.onData(data => send({ type: 'input', data: applyMods(data) }))
    new ResizeObserver(() => ready && fitSize()).observe(box)
    sendKey = data => send({ type: 'input', data })
    appCursor = () => t.modes.applicationCursorKeysMode
    touchScroll(box, t, fitSize)
    if (touch.matches) keepBackspaceRepeating(t)
    closeFind()
    watchChoices(t)
}

/**
 * Touch scrolling with the phone's own feel: an invisible native scroll layer lies over the terminal, and whatever
 * distance it scrolls (drag or iOS's own fling) is passed on, as a mouse wheel would scroll:
 * - an app that reads the mouse (Claude Code, Codex, vim with mouse on) gets wheel events, so it scrolls its own view;
 * - a full-screen app without mouse (less) gets ↑/↓;
 * - otherwise the terminal's own history scrolls.
 * ↑/↓ on the key bar stay keys (command history). A tap on the layer focuses the terminal for typing.
 */
function touchScroll (box, t, fitSize) {
    if (!touch.matches) return
    const MIDDLE = 500000
    const layer = el('div', { className: 'scroller' }, el('div', { className: 'scroller-space' }))
    box.parentElement.append(layer)
    let last = MIDDLE
    requestAnimationFrame(() => { layer.scrollTop = last = MIDDLE })
    let rest = 0
    const lineHeight = () => box.querySelector('.xterm-rows > div')?.offsetHeight || 15
    // Apps scroll about 3 lines per wheel step, so a step costs 3 lines of finger travel: the text follows the finger.
    const stepPx = () => lineHeight() * (t.modes.mouseTrackingMode !== 'none' ? 3 : 1)
    const scrollPx = px => {
        rest += px
        const lines = Math.trunc(rest / stepPx())
        if (!lines) return
        rest -= lines * stepPx()
        if (t.modes.mouseTrackingMode !== 'none') {
            // xterm turns each wheel event into the report the app asked for (SGR or X10), mid-screen.
            const r = box.getBoundingClientRect()
            for (let i = 0; i < Math.abs(lines); i++) {
                t.element.dispatchEvent(new WheelEvent('wheel', {
                    deltaY: Math.sign(lines) * lineHeight(), deltaMode: 0, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, bubbles: true, cancelable: true,
                }))
            }
        } else if (t.buffer.active.type === 'alternate') {
            sendKey(keySeq(lines > 0 ? 'down' : 'up').repeat(Math.abs(lines)))
        } else {
            t.scrollLines(lines)
        }
    }
    let idle = 0
    layer.addEventListener('scroll', () => {
        const d = layer.scrollTop - last
        last = layer.scrollTop
        // A jump of several screens at once is the layer being reset (a refresh, a re-layout), not a finger:
        // passing it on would throw the terminal to one end of its history.
        if (Math.abs(d) < layer.clientHeight * 4) scrollPx(d)
        // Back to the middle once it rests, so there is always room both ways (500k px: no fling reaches an end).
        clearTimeout(idle)
        idle = setTimeout(() => { layer.scrollTop = last = MIDDLE }, 400)
    }, { passive: true })
    // Typing starts only from a tap on the cursor's line (plus a finger's margin around it), like tapping a text field.
    // A tap anywhere else puts the keyboard away.
    let taps = 0
    let lastTap = null
    let pendingBlur = 0
    // The Copy chip goes whenever the selection does (new output, a tap, scrolling) and whenever the list scrolls.
    t.onSelectionChange(() => { if (!t.hasSelection()) $('copy-chip').hidden = true })
    layer.addEventListener('scroll', () => { $('copy-chip').hidden = true }, { passive: true })
    // Double tap and hold, then drag: the selection grows from that word to the finger, word by word's end.
    let drag = null
    layer.addEventListener('touchstart', e => {
        drag = null
        const p = e.touches[0]
        if (e.touches.length !== 1 || !lastTap || e.timeStamp - lastTap.t > 350 || Math.hypot(p.clientX - lastTap.x, p.clientY - lastTap.y) > 24) return
        const screen = t.element.querySelector('.xterm-screen').getBoundingClientRect()
        const at = cellAt(t, screen, p)
        drag = { screen, anchor: rangeAt(t, at, 'word') ?? { start: at, end: at + 1 }, moved: false }
        // Not a cursor slide or a sidebar swipe.
        layer.dataset.selecting = '1'
        layer.dataset.sliding = '1'
    }, { passive: true })
    layer.addEventListener('touchmove', e => {
        if (!drag) return
        e.preventDefault()
        drag.moved = true
        const at = cellAt(t, drag.screen, e.touches[0])
        const word = rangeAt(t, at, 'word') ?? { start: at, end: at + 1 }
        selectRange(t, { start: Math.min(drag.anchor.start, word.start), end: Math.max(drag.anchor.end, word.end) })
        drag.y = e.touches[0].clientY
    }, { passive: false })
    layer.addEventListener('touchend', () => {
        delete layer.dataset.selecting
        if (drag) setTimeout(() => delete layer.dataset.sliding)
        if (!drag?.moved) return
        showChip(t, drag.screen, drag.y)
        // The release is not a tap: the click that follows must not count as another one.
        taps = 0
        lastTap = null
        const swallow = ev => ev.stopPropagation()
        layer.addEventListener('click', swallow, { capture: true, once: true })
        setTimeout(() => layer.removeEventListener('click', swallow, { capture: true }), 400)
        drag = null
    })
    // A tap leaves the keyboard as it was; only the click handler below decides to raise or drop it.
    layer.addEventListener('mousedown', e => e.preventDefault())
    layer.addEventListener('click', e => {
        const b = t.buffer.active
        const screen = t.element.querySelector('.xterm-screen').getBoundingClientRect()
        const cell = screen.height / t.rows
        const row = b.cursorY + b.baseY - b.viewportY
        // Double tap selects a word, triple tap the line, as with a mouse on a computer.
        const near = lastTap && e.timeStamp - lastTap.t < 350 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 24
        taps = near ? taps + 1 : 1
        lastTap = { x: e.clientX, y: e.clientY, t: e.timeStamp }
        if (taps >= 2) {
            // Part of a double or triple tap: the keyboard stays as it was.
            clearTimeout(pendingBlur)
            return selectAt(t, screen, e, taps >= 3 ? 'line' : 'word')
        }
        if (t.hasSelection()) t.clearSelection()
        const middle = screen.top + (row + 0.5) * cell
        const reach = Math.max(1.5 * cell, 28)
        // No cursor line on screen (scrolled up, or Tabby took the size back): any tap starts typing again.
        const shown = layer.getBoundingClientRect()
        const visible = row >= 0 && row < t.rows && middle >= shown.top && middle <= shown.bottom
        if (!visible) return t.focus()
        if (Math.abs(e.clientY - middle) > reach) {
            // Waits a moment: if a second tap follows, it is a double tap (select), and the keyboard stays.
            clearTimeout(pendingBlur)
            pendingBlur = setTimeout(() => {
                t.blur()
                document.activeElement?.blur?.()
            }, 320)
            return
        }
        t.focus()
        // Tap on the line being typed: move the cursor to that spot, as in a text field. The distance in cells
        // (rows count as whole widths, for input that wraps) becomes ← or →; the shell or Claude stops at the ends.
        const tapRow = Math.max(0, Math.min(t.rows - 1, Math.floor((e.clientY - screen.top) / cell)))
        const tapCol = Math.max(0, Math.min(t.cols - 1, Math.floor((e.clientX - screen.left) / (screen.width / t.cols))))
        // Never past the end of what is typed: → there would accept the grey suggestion (Claude, PowerShell).
        const cells = Math.min((tapRow - row) * t.cols + (tapCol - b.cursorX), typedAhead(t))
        if (cells) sendKey(keySeq(cells > 0 ? 'right' : 'left').repeat(Math.min(Math.abs(cells), 400)))
    })
    holdSlide(layer, t)
    scrollBar(box.parentElement, t)

    // Pinch on the terminal changes the text size, as terminal apps do; the terminal refits to the new size,
    // and the size is remembered on this device. (Page zoom is off, so the layout never jumps.)
    let pinch = null
    let queued = false
    const gap = e => Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY)
    layer.addEventListener('touchstart', e => {
        if (e.touches.length === 2) pinch = { gap: gap(e), size: t.options.fontSize }
    }, { passive: true })
    layer.addEventListener('touchmove', e => {
        if (!pinch || e.touches.length !== 2) return
        e.preventDefault()
        const size = Math.min(28, Math.max(8, Math.round(pinch.size * gap(e) / pinch.gap * 2) / 2))
        if (size === t.options.fontSize) return
        t.options.fontSize = size
        remember('fontSize', size)
        // One refit per frame, after xterm has measured the new font.
        if (queued) return
        queued = true
        requestAnimationFrame(() => {
            queued = false
            fitSize()
        })
    }, { passive: false })
    layer.addEventListener('touchend', e => {
        if (e.touches.length < 2) pinch = null
    })
}

/**
 * How many cells of real typing follow the cursor: up to the last character, stopping at dim text, which is a
 * suggestion (Claude Code's suggested prompt, PowerShell's prediction) that → would accept. Follows wrapped rows.
 */
function typedAhead (t) {
    const b = t.buffer.active
    let y = b.baseY + b.cursorY
    let x = b.cursorX
    let count = 0
    let last = 0
    for (let guard = 0; guard < 4000; guard++) {
        if (x >= t.cols) {
            if (!b.getLine(y + 1)?.isWrapped) break
            y++
            x = 0
        }
        const c = b.getLine(y)?.getCell(x)
        if (!c || c.isDim()) break
        count++
        if (c.getChars().trim()) last = count
        x++
    }
    return last
}

/** The buffer cell under a point, as a position counted along the buffer (row * cols + col). */
function cellAt (t, screen, e) {
    const col = Math.max(0, Math.min(t.cols - 1, Math.floor((e.clientX - screen.left) / (screen.width / t.cols))))
    const row = t.buffer.active.viewportY + Math.max(0, Math.min(t.rows - 1, Math.floor((e.clientY - screen.top) / (screen.height / t.rows))))
    return row * t.cols + col
}

/**
 * The text a tap means, as { start, end } buffer positions: a word (paths and URLs whole), or the line's text
 * inside the field it sits in: between box borders (Claude Code's input, TUI panes), past a shell prompt, trimmed.
 * Counts one character per cell, so a line with wide characters (CJK, some emoji) is off by a few.
 */
function rangeAt (t, at, what) {
    const b = t.buffer.active
    const row = Math.floor(at / t.cols)
    if (what === 'word') {
        const text = b.getLine(row)?.translateToString(false) ?? ''
        const col = at % t.cols
        const sep = ch => !ch || /[\s"'`()[\]{}<>|;,│┃║]/.test(ch)
        if (sep(text[col])) return null
        let start = col
        let end = col
        while (start > 0 && !sep(text[start - 1])) start--
        while (end < text.length && !sep(text[end])) end++
        return { start: row * t.cols + start, end: row * t.cols + end }
    }
    // A line that wraps over several rows is one line.
    let top = row
    let bottom = row
    while (top > 0 && b.getLine(top)?.isWrapped) top--
    while (b.getLine(bottom + 1)?.isWrapped) bottom++
    let text = ''
    for (let y = top; y <= bottom; y++) text += (b.getLine(y)?.translateToString(false) ?? '').padEnd(t.cols).slice(0, t.cols)
    const tap = at - top * t.cols
    let start = 0
    let end = text.length
    for (let i = tap - 1; i >= 0; i--) if (/[│┃║]/.test(text[i])) { start = i + 1; break }
    for (let i = tap; i < text.length; i++) if (/[│┃║]/.test(text[i])) { end = i; break }
    let part = text.slice(start, end)
    start += part.length - part.trimStart().length
    part = part.trim()
    const prompt = part.match(/^(?:PS )?[A-Za-z]:\\[^>]*>\s*|^[❯›>$#%]\s+/)
    if (prompt && prompt[0].length < part.length) {
        start += prompt[0].length
        part = part.slice(prompt[0].length)
    }
    if (!part) return null
    return { start: top * t.cols + start, end: top * t.cols + start + part.length }
}

function selectRange (t, r) {
    t.select(r.start % t.cols, Math.floor(r.start / t.cols), r.end - r.start)
}

function showChip (t, screen, y) {
    if (!t.hasSelection()) return
    const chip = $('copy-chip')
    chip.hidden = false
    chip.style.top = `${Math.max(screen.top + 4, y - 64)}px`
}

/** Double tap: the word under the finger; triple tap: the line in its field. Then a Copy chip. */
function selectAt (t, screen, e, what) {
    const r = rangeAt(t, cellAt(t, screen, e), what)
    if (!r) return
    selectRange(t, r)
    showChip(t, screen, e.clientY)
}

/** Copies text on this device. The page is plain http on the LAN, so where the clipboard API is blocked a
 *  hidden text box and the browser's copy command do it (inside the tap, as browsers require). */
function copyText (text) {
    if (navigator.clipboard?.writeText && window.isSecureContext) return navigator.clipboard.writeText(text)
    const was = document.activeElement
    const ta = el('textarea', { value: text, readOnly: true, style: 'position:fixed;top:0;left:0;opacity:0' })
    document.body.append(ta)
    ta.select()
    ta.setSelectionRange(0, text.length)
    document.execCommand('copy')
    ta.remove()
    // Back to where typing was, so the keyboard stays up.
    was?.focus?.({ preventScroll: true })
}

$('chip-copy').onclick = () => {
    const text = term?.getSelection() ?? ''
    term?.clearSelection()
    $('copy-chip').hidden = true
    flash('Copied')
}

/**
 * Hold and slide to move the cursor: hold a finger on the line being typed for a moment, then slide; each cell
 * the finger crosses becomes ← or →. (iPhone's own space-bar trackpad cannot drive a web terminal: it moves the
 * caret of a hidden, near-zero-size text box, which snaps to its start.)
 */
function holdSlide (layer, t) {
    let hold = null // { x, y, timer, sliding, sent, cellW }
    const onCursorLine = y => {
        const b = t.buffer.active
        const screen = t.element.querySelector('.xterm-screen').getBoundingClientRect()
        const cell = screen.height / t.rows
        const middle = screen.top + (b.cursorY + b.baseY - b.viewportY + 0.5) * cell
        return Math.abs(y - middle) <= Math.max(1.5 * cell, 28) ? screen.width / t.cols : 0
    }
    layer.addEventListener('touchstart', e => {
        clearTimeout(hold?.timer)
        hold = null
        if (e.touches.length !== 1 || layer.dataset.selecting) return
        const { clientX: x, clientY: y } = e.touches[0]
        const cellW = onCursorLine(y)
        if (!cellW) return
        hold = { x, y, cellW, sliding: false, sent: 0 }
        hold.timer = setTimeout(() => {
            if (!hold) return
            hold.sliding = true
            // Tells the sidebar swipe that this horizontal move is the cursor, not a swipe.
            layer.dataset.sliding = '1'
            navigator.vibrate?.(10)
        }, 300)
    }, { passive: true })
    layer.addEventListener('touchmove', e => {
        if (!hold) return
        const { clientX: x, clientY: y } = e.touches[0]
        if (!hold.sliding) {
            // Moved before the hold took: an ordinary scroll.
            if (Math.hypot(x - hold.x, y - hold.y) > 8) {
                clearTimeout(hold.timer)
                hold = null
            }
            return
        }
        e.preventDefault()
        // Not past the end of what is typed, so the slide never accepts a grey suggestion.
        hold.maxRight ??= typedAhead(t)
        const cells = Math.min(Math.round((x - hold.x) / hold.cellW), hold.maxRight)
        const step = cells - hold.sent
        if (step) sendKey(keySeq(step > 0 ? 'right' : 'left').repeat(Math.abs(step)))
        hold.sent = cells
    }, { passive: false })
    layer.addEventListener('touchend', () => {
        if (hold?.sliding) {
            // The release must not also place the cursor where the finger stopped (tap to place).
            const swallow = ev => ev.stopPropagation()
            layer.addEventListener('click', swallow, { capture: true, once: true })
            setTimeout(() => layer.removeEventListener('click', swallow, { capture: true }), 400)
        }
        clearTimeout(hold?.timer)
        hold = null
        setTimeout(() => delete layer.dataset.sliding)
    })
}

/**
 * Scroll bar for the terminal's history on touch screens: the thumb is sized to the share of history on screen and
 * can be dragged; a tap on the track pages up or down. Hidden without history, and in full-screen apps such as
 * Claude Code, which keep their own history the page cannot see.
 */
function scrollBar (host, t) {
    const thumb = el('div', { className: 'vbar-thumb' })
    const bar = el('div', { className: 'vbar', ariaHidden: 'true' }, thumb)
    host.append(bar)
    const update = () => {
        const b = t.buffer.active
        const show = b.type === 'normal' && b.baseY > 0
        bar.hidden = !show
        if (!show) return
        const track = bar.clientHeight
        const size = Math.max(32, track * t.rows / (b.baseY + t.rows))
        thumb.style.height = `${size}px`
        thumb.style.transform = `translateY(${(track - size) * b.viewportY / b.baseY}px)`
    }
    t.onScroll(update)
    t.onWriteParsed(update)
    t.onResize(update)
    t.buffer.onBufferChange(update)
    new ResizeObserver(update).observe(bar)

    let grab = null
    bar.addEventListener('pointerdown', e => {
        e.preventDefault()
        const r = thumb.getBoundingClientRect()
        if (e.clientY < r.top || e.clientY > r.bottom) return t.scrollPages(e.clientY < r.top ? -1 : 1)
        grab = { y: e.clientY, line: t.buffer.active.viewportY }
        bar.setPointerCapture(e.pointerId)
    })
    bar.addEventListener('pointermove', e => {
        if (!grab) return
        const free = bar.clientHeight - thumb.offsetHeight
        const b = t.buffer.active
        t.scrollToLine(Math.round(grab.line + (e.clientY - grab.y) / Math.max(free, 1) * b.baseY))
    })
    const drop = () => { grab = null }
    bar.addEventListener('pointerup', drop)
    bar.addEventListener('pointercancel', drop)
}

// ---- Key bar for touch screens: Termux's two-row layout, with a sticky Shift the iPhone keyboard lacks ----

const mods = { ctrl: false, alt: false, shift: false }
let sendKey = () => {}
let appCursor = () => false
const setMod = (name, on) => {
    mods[name] = on
    document.querySelector(`[data-key="${name}"]`).ariaPressed = String(on)
}
const clearMods = () => ['ctrl', 'alt', 'shift'].forEach(m => setMod(m, false))
/** Sticky Shift, Ctrl and Alt apply to the next key, from the bar or the phone keyboard. */
function applyMods (data) {
    if (mods.shift && data.length === 1) data = data.toUpperCase()
    if (mods.ctrl && data.length === 1 && /[a-z@[\\\]^_ ]/i.test(data)) {
        data = data === ' ' ? '\x00' : String.fromCharCode(data.toUpperCase().charCodeAt(0) & 31)
    }
    if (mods.alt) data = '\x1b' + data
    clearMods()
    return data
}
/** The bytes for a key-bar key, with the held modifiers in xterm's encoding (CSI 1;m X, m = 1 + Shift + 2·Alt + 4·Ctrl). */
function keySeq (k) {
    const m = 1 + (mods.shift ? 1 : 0) + (mods.alt ? 2 : 0) + (mods.ctrl ? 4 : 0)
    const letter = { up: 'A', down: 'B', right: 'C', left: 'D', home: 'H', end: 'F' }[k]
    // Arrows follow the app's cursor mode (vim, less and full-screen apps switch it).
    if (letter) return m > 1 ? `\x1b[1;${m}${letter}` : k === 'home' || k === 'end' ? KEYS[k] : (appCursor() ? '\x1bO' : '\x1b[') + letter
    const page = { pgup: 5, pgdn: 6 }[k]
    if (page) return m > 1 ? `\x1b[${page};${m}~` : KEYS[k]
    if (k === 'tab') return (mods.alt ? '\x1b' : '') + (mods.shift ? '\x1b[Z' : '\t')
    return (mods.alt ? '\x1b' : '') + KEYS[k]
}
// ---- Copy and Paste: a sheet with a plain text box ----
// The page is plain http on the LAN, where browsers block clipboard access from script; inside a text box the
// phone's own select, copy and paste menus always work.

/** The terminal's screen as text, wrapped lines joined back into one, trailing blank lines dropped. */
function screenText (t) {
    const b = t.buffer.active
    const lines = []
    for (let y = b.viewportY; y < b.viewportY + t.rows; y++) {
        const line = b.getLine(y)
        if (!line) continue
        const text = line.translateToString(true)
        if (line.isWrapped && lines.length) lines[lines.length - 1] += text
        else lines.push(text)
    }
    while (lines.length && !lines.at(-1).trim()) lines.pop()
    return lines.join('\n')
}

function openSheet (kind) {
    if (!term) return
    const box = $('sheet-text')
    $('sheet').dataset.kind = kind
    $('sheet-title').textContent = kind === 'copy' ? 'Copy' : 'Paste'
    $('sheet-go').textContent = kind === 'copy' ? 'Copy all' : 'Send'
    box.readOnly = kind === 'copy'
    box.value = kind === 'copy' ? screenText(term) : ''
    box.placeholder = kind === 'paste' ? 'Paste or type here' : ''
    $('sheet').hidden = false
    // Across devices: pull the PC's clipboard, attach a file from the phone, or put the copied text on the PC.
    const extra = kind === 'paste'
        ? [el('button', { textContent: 'From PC', onclick: pasteFromPc }), el('button', { textContent: 'Attach…', onclick: () => $('file-pick').click() })]
        : [el('button', { textContent: 'Copy to PC', onclick: copyToPc })]
    $('sheet-extra').replaceChildren(...extra)
    if (kind === 'paste') {
        box.focus()
        // Where the browser allows it (https, localhost), fill it straight from the clipboard.
        navigator.clipboard?.readText?.().then(text => { if (!box.value) box.value = text }).catch(() => {})
    } else {
        box.scrollTop = box.scrollHeight
    }
}

/** Pastes file paths at the cursor, quoted when they hold spaces; Claude Code attaches an image given its path. */
function pastePaths (paths) {
    term?.paste(paths.map(p => /\s/.test(p) ? `"${p}"` : p).join(' ') + ' ')
}

async function pasteFromPc () {
    const r = await api('/api/clipboard')
    if (!r.ok) return flash('Needs a Tabby restart')
    const { text, path } = await r.json()
    // An image on the PC's clipboard arrives as a saved file: paste its path straight away.
    if (path) {
        closeSheet()
        return pastePaths([path])
    }
    $('sheet-text').value = text ?? ''
}

async function copyToPc () {
    const r = await api('/api/clipboard', { method: 'PUT', body: JSON.stringify({ text: $('sheet-text').value }) })
    if (!r.ok) return flash('Needs a Tabby restart')
    $('sheet-extra').querySelector('button').textContent = 'On the PC ✓'
    setTimeout(closeSheet, 700)
}

$('attach').onclick = () => term && $('file-pick').click()

// Attach: each picked file uploads to a temp folder on the PC, then its path is pasted at the cursor.
$('file-pick').addEventListener('change', async () => {
    const files = [...$('file-pick').files]
    $('file-pick').value = ''
    if (!files.length) return
    closeSheet()
    setStatus(`Uploading ${files.length === 1 ? files[0].name : files.length + ' files'}…`)
    const paths = []
    for (const f of files) {
        const r = await fetch('/api/upload', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'X-Filename': encodeURIComponent(f.name || 'photo.jpg') }, body: f }).catch(() => null)
        if (r?.ok) paths.push((await r.json()).path)
    }
    setStatus(null)
    if (paths.length) pastePaths(paths)
    if (paths.length < files.length) flash(paths.length ? 'Some files failed' : 'Upload failed (a Tabby restart may be needed)')
})

function closeSheet () {
    $('sheet').hidden = true
    $('sheet-text').blur()
    // Closing a rename box without saving answers "no change".
    promptDone?.(null)
}

$('sheet-close').onclick = closeSheet
$('sheet').addEventListener('click', e => e.target === $('sheet') && closeSheet())
// In a rename box, Enter saves.
$('sheet-text').addEventListener('keydown', e => {
    if (e.key === 'Enter' && $('sheet').dataset.kind === 'prompt') {
        e.preventDefault()
        $('sheet-go').click()
    }
})
$('sheet-go').onclick = async () => {
    const box = $('sheet-text')
    if ($('sheet').dataset.kind === 'prompt') return promptDone?.(box.value)
    if ($('sheet').dataset.kind === 'paste') {
        // xterm's paste: bracketed when the app asks for it, and newlines sent as Enter.
        if (box.value) term?.paste(box.value)
        return closeSheet()
    }
    copyText(box.value)
    $('sheet-go').textContent = 'Copied'
    setTimeout(closeSheet, 600)
}

// Away when the phone locks or the page goes to the background; back when it returns. Others see it on the badge.
document.addEventListener('visibilitychange', () => {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'presence', state: document.hidden ? 'away' : 'here' }))
})

// No page zoom: it would fight the keyboard-fitted layout. Safari ignores user-scalable=no, but not these.
for (const type of ['gesturestart', 'gesturechange']) document.addEventListener(type, e => e.preventDefault())
$('keys').hidden = !touch.matches
$('keys').addEventListener('pointerdown', e => e.preventDefault()) // keep the phone keyboard open
$('keys').addEventListener('click', e => {
    const k = e.target.closest('button')?.dataset.key
    if (!k) return
    if (k === 'ctrl' || k === 'alt' || k === 'shift') return setMod(k, !mods[k])
    if (k === 'copy' || k === 'paste') return openSheet(k)
    sendKey(keySeq(k))
    clearMods()
})

// ---- Keyboard: keep the page in the visible area, so the prompt stays above the phone keyboard ----

const vv = window.visualViewport
if (vv) {
    const follow = () => {
        const root = document.documentElement.style
        root.setProperty('--vvh', `${vv.height}px`)
        root.setProperty('--vvtop', `${vv.offsetTop}px`)
        // Keyboard up (the visible area is well short of the window): the home-indicator gap at the bottom is
        // covered by the keyboard, so the key bar must sit right on top of it. Matters in the Home Screen app,
        // where that gap is real; in Safari it is already 0.
        document.body.classList.toggle('keyboard', window.innerHeight - vv.height > 120)
        window.scrollTo(0, 0)
        // The terminal box shrank; its ResizeObserver refits, then we show the cursor line.
        requestAnimationFrame(() => term?.scrollToBottom())
    }
    vv.addEventListener('resize', follow)
    vv.addEventListener('scroll', follow)
    follow()
}

// ---- Boot ----

;(async () => {
    if (await tryPair()) return
    if (token) start()
    else signOut()
})()

// ---- Search: Tabby's own (Ctrl+Shift+F), with a match count, up/down, case, regex and whole word ----

const findOpts = { caseSensitive: false, regex: false, wholeWord: false, ...saved('find') }
const MATCHES = { matchBackground: '#5c4a10', activeMatchBackground: '#c08a00', matchOverviewRuler: '#888888', activeMatchColorOverviewRuler: '#ffb000' }

async function openFind () {
    if (!term) return
    // Loaded on first use, so the page still works on a Tabby that does not serve it yet.
    if (!window.SearchAddon) await new Promise(resolve => document.head.append(el('script', { src: 'addon-search.js', onload: resolve, onerror: resolve })))
    if (!window.SearchAddon) return flash('Needs a Tabby restart')
    if (!term.__find) {
        const s = term.__find = new SearchAddon.SearchAddon()
        term.loadAddon(s)
        s.onDidChangeResults(({ resultIndex, resultCount }) => {
            const text = $('find-text').value
            $('find-count').textContent = text && resultCount ? `${resultIndex + 1} / ${resultCount}` : ''
            $('find-text').classList.toggle('none', !!text && !resultCount)
            $('find-prev').hidden = $('find-next').hidden = !(text && resultCount)
        })
    }
    $('find').hidden = false
    $('find-text').focus()
    $('find-text').select()
    if ($('find-text').value) find(1, true)
}

function closeFind () {
    if ($('find').hidden) return
    $('find').hidden = true
    term?.__find?.clearDecorations()
    term?.clearSelection()
    $('find-text').blur()
}

function find (dir, incremental = false) {
    const s = term?.__find
    const text = $('find-text').value
    if (!s) return
    if (!text) {
        s.clearDecorations()
        term.clearSelection()
        $('find-count').textContent = ''
        $('find-text').classList.remove('none')
        $('find-prev').hidden = $('find-next').hidden = true
        return
    }
    const o = { ...findOpts, incremental, decorations: MATCHES }
    if (dir < 0) s.findPrevious(text, o)
    else s.findNext(text, o)
}

$('find-btn').onclick = () => $('find').hidden ? openFind() : closeFind()
$('find-close').onclick = closeFind
$('find-prev').onclick = () => find(-1)
$('find-next').onclick = () => find(1)
$('find-text').addEventListener('input', () => find(1, true))
$('find-text').addEventListener('keydown', e => {
    if (e.key === 'Enter') {
        e.preventDefault()
        find(e.shiftKey ? -1 : 1)
    } else if (e.key === 'Escape') {
        closeFind()
        term?.focus()
    }
})
for (const [id, key] of [['find-case', 'caseSensitive'], ['find-regex', 'regex'], ['find-word', 'wholeWord']]) {
    $(id).ariaPressed = String(findOpts[key])
    $(id).onclick = () => {
        findOpts[key] = !findOpts[key]
        $(id).ariaPressed = String(findOpts[key])
        remember('find', findOpts)
        find(1, true)
    }
}
// The search bar's buttons leave the keyboard up for the search box.
$('find').addEventListener('pointerdown', e => e.target.closest('button') && e.preventDefault())
document.addEventListener('keydown', e => {
    if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        openFind()
    }
}, true)

// ---- Claude's questions as buttons ----

/**
 * The open question on screen, as its options' text: Claude's numbered list with its ❯ marker ("❯ 1. Yes",
 * "2. No"), the last one on screen, with nothing after it but its footer. Once answered, Claude's input box (❯ at the
 * line start) comes back below it, and the list no longer counts.
 */
function choicesOn (t) {
    const b = t.buffer.active
    let found = null
    let cur = null
    let after = 0
    for (let y = b.viewportY; y < b.viewportY + t.rows; y++) {
        const line = b.getLine(y)?.translateToString(true) ?? ''
        const m = line.match(/^\s*(❯\s*)?(\d)\.\s+(.+)$/)
        if (m && (m[2] === '1' || (cur && Number(m[2]) === cur.options.length + 1))) {
            if (m[2] === '1') cur = { options: [], marked: false }
            cur.options.push(m[3].trim())
            cur.marked ||= !!m[1]
            cur.indent = line.length - m[3].length
            if (cur.marked && cur.options.length >= 2) {
                found = cur
                after = 0
            }
            continue
        }
        // A long option wraps onto lines indented under its text.
        if (cur && line.trim() && line.search(/\S/) >= cur.indent) {
            cur.options[cur.options.length - 1] += ' ' + line.trim()
            continue
        }
        cur = null
        if (found && line.trim() && (/^❯/.test(line) || ++after > 4)) found = null
    }
    return found?.options ?? null
}

function watchChoices (t) {
    $('answers').hidden = true
    let shown = ''
    let queued = false
    const update = () => {
        queued = false
        if (t !== term) return
        const options = choicesOn(t)
        const key = JSON.stringify(options)
        if (key === shown) return
        shown = key
        $('answers').hidden = !options
        $('answers').replaceChildren(...(options ? [el('div', {}, ...options.map((text, i) =>
            // Claude takes the option's number as the answer at once.
            el('button', { onclick: () => sendKey(String(i + 1)) }, el('b', { textContent: i + 1 }), text)))] : []))
    }
    const queue = () => {
        if (queued) return
        queued = true
        setTimeout(update, 120)
    }
    t.onWriteParsed(queue)
    t.onScroll(queue)
    t.onResize(queue)
    queue()
}
// Answering leaves the phone keyboard as it was.
$('answers').addEventListener('pointerdown', e => e.preventDefault())

/** Tabby's terminal colours (its colour scheme), so a tab looks here as it does in Tabby. An older server sends none. */
function applyTheme (t, theme) {
    if (!theme) return
    t.options.theme = theme
    if (theme.background) document.documentElement.style.setProperty('--term-bg', theme.background)
}

/**
 * iPhone repeats a held ⌫ only while the text box has text to delete, and the terminal's hidden text box is always
 * empty (each key goes straight to the terminal), so ⌫ deleted once per press. A few invisible characters keep it
 * repeating; each ⌫ still sends the terminal one delete, and the filler is topped up after every key.
 */
function keepBackspaceRepeating (t) {
    const ta = t.textarea
    const FILL = '​'.repeat(8)
    let composing = false
    const refill = () => setTimeout(() => {
        if (composing || ta.value === FILL || document.activeElement !== ta) return
        ta.value = FILL
        ta.setSelectionRange(FILL.length, FILL.length)
    })
    ta.addEventListener('compositionstart', () => { composing = true })
    ta.addEventListener('compositionend', () => { composing = false; refill() })
    for (const type of ['focus', 'input', 'keyup']) ta.addEventListener(type, refill)
}
