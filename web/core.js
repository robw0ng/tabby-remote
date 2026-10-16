// Tabby Remote web client: a sidebar like tabby-groups' and one attached terminal pane. Shared helpers and state.

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
// tabby-groups' readability rule: a subgroup the same colour as its parent is darker, one more step for each such
// level in a row; a subgroup of another colour keeps its normal look. 36% per step (this side bar is dark).
const shadeOf = g => {
    const parent = g.parent && groups.find(x => x.name === g.parent)
    const same = parent && (parent.color ?? NO_COLOR).toLowerCase() === (g.color ?? NO_COLOR).toLowerCase()
    return same ? shadeOf(parent) + 1 : 0
}
const darken = (fill, shade) => shade ? `color-mix(in srgb, ${fill}, #000 ${Math.min(36 * shade, 100)}%)` : fill
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
let computer = '' // this computer's name, from the server
let socket = null
let term = null
let events = null

const api = (path, opts = {}) => fetch(path, { ...opts, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` } })

/** The pill under the header: "Reconnecting…" or "Tab closed"; null hides it. A fresh snapshot clears it. */
function setStatus (text) {
    $('status').textContent = text ?? ''
    $('status').hidden = !text
    // Amber while it retries, red when there is nothing to go back to.
    // Amber while something is under way ("Reconnecting…", "Uploading…"), red otherwise.
    $('status').dataset.kind = text?.endsWith('…') ? 'wait' : 'gone'
}

function flash (text) {
    setStatus(text)
    setTimeout(() => setStatus(null), 2000)
}
