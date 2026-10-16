const { NgModule, Injector, NgZone, ElementRef, ɵɵdefineComponent, ɵɵdirectiveInject } = require('@angular/core')
const core = require('tabby-core')
const http = require('http')
const fs = require('fs')
const path = require('path')
const os = require('os')
const crypto = require('crypto')
const ws = require('./ws')

const VERSION = require('./package.json').version

const sha = s => crypto.createHash('sha256').update(String(s)).digest()
const MAX_UPLOAD = 50 << 20

/** IPv4 loopback and private (RFC 1918) addresses; never 0.0.0.0. */
function lanAddresses () {
    return Object.values(os.networkInterfaces()).flat()
        .filter(a => a.family === 'IPv4' && (a.internal || /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address)))
        .map(a => a.address)
}

function install (injector) {
    // Reloading in place (a new index.js, Tabby kept running): the old instance lets go first, and the new server
    // starts once the old one has released its port.
    const previous = Promise.resolve(window.__tabbyRemote?.dispose()).catch(() => {})

    const app = injector.get(core.AppService)
    const profiles = injector.get(core.ProfilesService)
    const notifications = injector.get(core.NotificationsService)
    // Node's sockets call back outside Angular's zone; without this Tabby never renders a tab we open.
    const zone = injector.get(NgZone)
    const inZone = fn => (...args) => zone.run(() => fn(...args))
    // userData honours --user-data-dir; Tabby's config path does not.
    const storePath = path.join(require('@electron/remote').app.getPath('userData'), 'tabby-remote.json')

    // Settings (Tabby's Settings > Phone access) and paired devices, outside Tabby's config, which syncs between PCs.
    // Not 7680: Windows Delivery Optimization holds that port on every PC.
    let store = { enabled: true, name: null, port: 7681, passwordHash: null, devices: [], keepAwake: true, keepScreen: false, awakeMinutes: 30, announce: true, autoForget: true, forgetDays: 30 }
    try {
        store = { ...store, ...JSON.parse(fs.readFileSync(storePath, 'utf8')) }
    } catch { }
    // A permanent id for this Tabby, so a client that knows several computers recognises this one at a new address.
    const newComputerId = !store.computerId
    if (newComputerId) store.computerId = crypto.randomBytes(8).toString('hex')
    // The name a phone shows for this computer: the one set in Settings, else the computer's own.
    const computerName = () => store.name || os.hostname()
    const escapeHtml = s => String(s).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`)
    // The password is kept only as a salted scrypt hash; one saved in plain text by an older version is converted.
    const hashPassword = (pw, salt = crypto.randomBytes(16).toString('hex')) => `${salt}:${crypto.scryptSync(pw, salt, 32).toString('hex')}`
    const passwordOk = pw => {
        const [salt, hash] = (store.passwordHash ?? '').split(':')
        return !!hash && crypto.timingSafeEqual(Buffer.from(hashPassword(String(pw ?? ''), salt).split(':')[1], 'hex'), Buffer.from(hash, 'hex'))
    }
    // The port the server listens on; a new one from Settings applies after a restart. When it is taken (another Tabby
    // on this computer), the next free one is used and kept (see startServers).
    let listeningPort = store.port
    // After dispose this instance never writes again, so a stale copy cannot overwrite the new instance's settings.
    let disposed = false
    const save = () => disposed || fs.writeFileSync(storePath, JSON.stringify(store, null, 2))
    if (newComputerId) save()
    // Devices paired before "last seen" existed count from now, so none is forgotten as "used only once".
    if (store.devices.some(d => !d.lastSeen)) {
        store.devices.forEach(d => { d.lastSeen ??= Date.now() })
        save()
    }
    if (store.password) {
        store.passwordHash = hashPassword(store.password)
        delete store.password
        save()
    }

    const clients = new Set()
    const fails = new Map()

    // ---- Tabby model ----

    const idOf = o => (o.__trId ??= crypto.randomBytes(6).toString('hex'))
    const panesOf = tab => (tab.getAllTabs?.() ?? [tab]).filter(p => p.sendInput)

    function groupPath (tab) {
        const groups = window.__tabbyGroups?.list() ?? []
        const out = []
        for (let n = tab.__tg; n && out.length <= groups.length; n = groups.find(g => g.name === n)?.parent) {
            out.unshift(n)
        }
        return out
    }

    function layout (node) {
        if (!node.children) return idOf(node)
        if (node.children.length === 1) return layout(node.children[0])
        return { split: node.orientation, ratios: node.ratios, children: node.children.map(layout) }
    }

    function sizeOf (pane) {
        const s = pane.__trSize ?? (pane.size && { cols: pane.size.columns, rows: pane.size.rows })
        return s ? { cols: s.cols, rows: s.rows } : null
    }

    function session (tab) {
        const panes = panesOf(tab)
        const focused = tab.focusedTab ?? panes[0]
        return {
            id: idOf(tab),
            title: tab.customTitle || tab.title,
            kind: focused?.__tgInfo?.kind ?? null,
            cwd: focused?.__tgInfo?.cwd ?? null,
            group: groupPath(tab),
            index: app.tabs.indexOf(tab) + 1,
            // Tabby's pin, or tabby-groups' pin inside a group.
            pinned: !!(tab.pinned || tab.__tgPinned),
            active: app.activeTab === tab,
            remote: [...new Set([...clients].filter(c => panes.includes(c.pane)).map(c => c.device.name))],
            viewers: viewersOf(tab),
            // Claude's state from tabby-groups: { state: 'busy'|'waiting', since, needsYou } or null.
            agent: tab.__tgInfo?.agent ?? null,
            layout: tab.root ? layout(tab.root) : idOf(tab),
            panes: panes.map(p => ({
                id: idOf(p),
                kind: p.__tgInfo?.kind ?? null,
                cwd: p.__tgInfo?.cwd ?? null,
                focused: p === focused,
                size: sizeOf(p),
            })),
        }
    }

    // ---- Presence: which device is on which tab, and what it is doing ----

    // Device colours, picked to stay apart from the group palette.
    const DEVICE_COLORS = ['#4fc3f7', '#ffb74d', '#ba68c8', '#4db6ac', '#f06292', '#aed581', '#ffd54f', '#90a4ae']
    const colorOf = device => device.color ?? DEVICE_COLORS[Math.max(0, store.devices.indexOf(device)) % DEVICE_COLORS.length]
    const TYPING_MS = 4000

    /**
     * One entry per device attached to any pane of the tab: { id, name, color, state, sizer }.
     * state: 'typing' (sent keys in the last 4 s) > 'watching' > 'away' (its page is in the background).
     * sizer: the terminal is at this device's size (the size rule: the last remote typist sets it).
     */
    function viewersOf (tab) {
        const panes = panesOf(tab)
        const byDevice = new Map()
        for (const c of clients) {
            if (!panes.includes(c.pane)) continue
            const state = Date.now() - (c.lastInput ?? 0) < TYPING_MS ? 'typing' : c.away ? 'away' : 'watching'
            const rank = { typing: 2, watching: 1, away: 0 }
            const prev = byDevice.get(c.device.id)
            const sizer = panes.some(p => p.__trSizer === c.device.id)
            if (!prev || rank[state] > rank[prev.state]) byDevice.set(c.device.id, { id: c.device.id, name: c.device.name, color: colorOf(c.device), state, sizer: sizer || !!prev?.sizer })
        }
        return [...byDevice.values()]
    }

    // ---- Keep the PC awake while a device has a tab open ----
    // The PC does not sleep while anyone is attached, nor for a while (30 minutes by default) after the last one
    // leaves: a phone that locks drops its connection, and should still find the PC awake when it comes back.
    // The screen may still turn off. Off in Settings > Phone access.
    const { powerSaveBlocker } = require('@electron/remote')
    // "Keep the screen on" (off by default) also stops the screen turning off. That matters on laptops with Modern
    // Standby: there the screen turning off locks the PC and lets it drift into standby, which pauses Tabby even
    // though system sleep is blocked. It shares the minutes after the last device leaves.
    let awake = null
    let screenOn = null
    let awakeTimer = null
    function stayAwake () {
        if (!store.keepAwake && !store.keepScreen) return letSleep()
        if (clients.size) {
            clearTimeout(awakeTimer)
            awakeTimer = null
            if (awake === null) awake = powerSaveBlocker.start('prevent-app-suspension')
            if (store.keepScreen && screenOn === null) screenOn = powerSaveBlocker.start('prevent-display-sleep')
            if (!store.keepScreen && screenOn !== null) {
                powerSaveBlocker.stop(screenOn)
                screenOn = null
            }
        } else if ((awake !== null || screenOn !== null) && !awakeTimer) {
            awakeTimer = setTimeout(letSleep, store.awakeMinutes * 60 * 1000)
        }
    }
    function letSleep () {
        clearTimeout(awakeTimer)
        awakeTimer = null
        if (awake !== null) powerSaveBlocker.stop(awake)
        if (screenOn !== null) powerSaveBlocker.stop(screenOn)
        awake = screenOn = null
    }

    // For Tabby's own sidebar (tabby-groups draws the badges): each tab carries `__trPresence`, and a
    // 'tabby-remote:presence' event on window says it changed. Checked every second while anyone is attached.
    let presenceJson = new Map()
    function updatePresence () {
        stayAwake()
        let changed = false
        for (const tab of app.tabs) {
            const v = viewersOf(tab)
            const json = JSON.stringify(v)
            if ((presenceJson.get(tab) ?? '[]') === json) continue
            presenceJson.set(tab, json)
            tab.__trPresence = v
            changed = true
        }
        if (changed) window.dispatchEvent(new CustomEvent('tabby-remote:presence'))
    }
    const presenceTimer = setInterval(() => (clients.size || presenceJson.size) && updatePresence(), 1000)

    // ---- Colours: the terminal colour scheme Tabby uses now, as an xterm.js theme ----

    const config = injector.get(core.ConfigService)
    const ANSI = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white']
    function terminalTheme () {
        // Tabby loads its config after plugins start: no colours until then (the page keeps its defaults).
        if (!config.store?.terminal) return null
        const { terminal, appearance } = config.store
        const light = appearance?.colorSchemeMode === 'light'
            || (appearance?.colorSchemeMode === 'auto' && matchMedia('(prefers-color-scheme: light)').matches)
        const s = (light ? terminal.lightColorScheme : terminal.colorScheme) ?? {}
        const c = s.colors ?? []
        return {
            foreground: s.foreground,
            background: s.background,
            cursor: s.cursor,
            cursorAccent: s.cursorAccent,
            // Tabby's own default for a scheme without one.
            selectionBackground: s.selection ?? '#88888888',
            selectionForeground: s.selectionForeground,
            ...Object.fromEntries(ANSI.flatMap((name, i) => [[name, c[i]], ['bright' + name[0].toUpperCase() + name.slice(1), c[i + 8]]])),
        }
    }

    // ---- Size rule: the last remote typist sets the size; typing in Tabby takes it back ----

    function broadcastSize (pane) {
        const s = sizeOf(pane)
        for (const c of clients) {
            if (c.pane === pane && s) c.conn.send(JSON.stringify({ type: 'size', ...s }))
        }
    }

    function takeSize (client) {
        const { pane, size } = client
        if (size) {
            pane.__trSizer = client.device.id
            pane.__trSizerClient = client
        }
        if (!size || (pane.__trSize?.cols === size.cols && pane.__trSize?.rows === size.rows)) return
        pane.__trSize = size
        pane.__trResizedAt = Date.now()
        pane.session?.resize(size.cols, size.rows)
        broadcastSize(pane)
    }

    /** A client stops looking (page in the background, or gone): if it set the size, the size goes to the latest other
     *  device still looking at this pane, or back to Tabby. */
    function handOff (pane, leaving) {
        // By connection, not device: a page that reopens its tab closes the old connection after the new one took the size.
        if (pane.__trSizerClient !== leaving) return
        const next = [...clients].filter(c => c.pane === pane && c !== leaving && !c.away && c.size).at(-1)
        if (next) takeSize(next)
        else returnSize(pane)
    }

    function returnSize (pane) {
        if (!pane.__trSize) return
        pane.__trSize = pane.__trSizer = pane.__trSizerClient = null
        if (pane.size) pane.session?.resize(pane.size.columns, pane.size.rows)
        broadcastSize(pane)
    }

    // ---- Attach ----

    const hasClients = pane => [...clients].some(c => c.pane === pane)

    /** Per pane, while any client is attached: Tabby's own keys take the size back, and so does Tabby resizing the pane. */
    function watchTabby (pane) {
        const el = pane.element.nativeElement
        const onKey = () => returnSize(pane)
        el.addEventListener('keydown', onKey, true)
        el.addEventListener('paste', onKey, true)
        // Tabby resizes the PTY itself ~100 ms after its window or split changes; follow it. resize$ replays the last
        // size to each new subscriber; that replay is old news, not a resize.
        let replay = true
        const sub = pane.frontend.resize$.subscribe(() => !replay && setTimeout(() => {
            if (!pane.__trSize) return
            // A tab started for a remote client settles into Tabby's window first; that is not Tabby taking it back.
            if (Date.now() - (pane.__trStartedAt ?? 0) < 3000) return pane.session?.resize(pane.__trSize.cols, pane.__trSize.rows)
            pane.__trSize = pane.__trSizer = pane.__trSizerClient = null
            broadcastSize(pane)
        }, 150))
        replay = false
        pane.__trUnwatch = () => {
            el.removeEventListener('keydown', onKey, true)
            el.removeEventListener('paste', onKey, true)
            sub.unsubscribe()
        }
    }

    async function attach (conn, device, tab, pane) {
        const client = { conn, device, pane, size: null }
        const subs = []
        let inputQueue = Promise.resolve()
        // Registered first, so a client that leaves at any point below is cleaned up.
        conn.onClose(() => {
            subs.forEach(s => s.unsubscribe())
            const watched = clients.delete(client)
            if (!hasClients(pane)) {
                if (watched) pane.__trUnwatch?.()
                // Also when it left before the snapshot: a resize it sent early still has to be undone.
                returnSize(pane)
            } else {
                handOff(pane, client)
            }
            updatePresence()
        })
        // Input and resize work from the moment of auth; they do not wait for the snapshot.
        conn.onMessage(inZone(text => {
            let m
            try {
                m = JSON.parse(text)
            } catch {
                return
            }
            if (m.type === 'input' && typeof m.data === 'string') {
                const wasTyping = Date.now() - (client.lastInput ?? 0) < TYPING_MS
                client.lastInput = Date.now()
                if (!wasTyping) setTimeout(updatePresence)
                takeSize(client)
                // PSReadLine drops keys that land while it redraws for a resize, so input waits
                // out a fixed 200 ms after one. A shell that redraws slower would still lose keys.
                const wait = 200 - (Date.now() - (pane.__trResizedAt ?? 0))
                inputQueue = inputQueue
                    .then(() => wait > 0 && new Promise(resolve => setTimeout(resolve, wait)))
                    .then(() => pane.sendInput(m.data))
            } else if (m.type === 'resize' && Number.isInteger(m.cols) && Number.isInteger(m.rows)) {
                client.size = { cols: Math.min(Math.max(m.cols, 2), 1000), rows: Math.min(Math.max(m.rows, 2), 1000) }
                takeSize(client)
            } else if (m.type === 'presence') {
                // The page went to the background (phone locked, app swiped away, tab switched): Tabby gets its size
                // back. Back on screen, the device takes it again unless another device holds it now.
                client.away = m.state === 'away'
                if (client.away) handOff(pane, client)
                else if (!pane.__trSize) takeSize(client)
                updatePresence()
            }
        }))

        if (!pane.frontendIsReady) {
            // Tabby starts a restored background tab only when it is first shown.
            app.selectTab(tab)
            await new Promise(resolve => {
                const sub = pane.frontendReady.subscribe(() => { sub?.unsubscribe(); resolve() })
                setTimeout(resolve, 5000)
            })
            if (!pane.frontend) return conn.close(1011)
            pane.__trStartedAt = Date.now()
        }
        if (conn.closed) return

        const buffered = []
        let live = false
        subs.push(
            pane.output$.subscribe(data => live ? conn.send(Buffer.from(data)) : buffered.push(data)),
            pane.destroyed$.subscribe(() => {
                conn.send(JSON.stringify({ type: 'exit' }))
                conn.close()
            }),
        )
        if (!hasClients(pane)) watchTabby(pane)
        clients.add(client)
        updatePresence()

        // Queue the snapshot on Tabby's private write lock, so it holds exactly the output
        // emitted before our subscription and `buffered` holds the rest. Breaks if Tabby renames frontendWriteLock.
        // It must never throw there: a rejected lock would stop that pane rendering in Tabby.
        let snapshot = ''
        pane.frontendWriteLock = pane.frontendWriteLock.then(() => {
            try {
                snapshot = pane.frontend.serializeAddon.serialize()
                // The serialize addon keeps the mouse mode but not its encoding. Claude Code asks for SGR; without
                // it a refreshed page sends wheel events Claude ignores, until Claude redraws and asks again.
                const encoding = { SGR: '\x1b[?1006h', URXVT: '\x1b[?1015h', UTF8: '\x1b[?1005h' }[pane.frontend.xterm._core?.coreMouseService?.activeEncoding]
                if (encoding) snapshot += encoding
            } catch (e) {
                console.warn('[tabby-remote] snapshot', e)
            }
        })
        await pane.frontendWriteLock
        if (conn.closed || !pane.frontend) return
        const { cols, rows } = pane.frontend.xterm
        conn.send(JSON.stringify({ type: 'snapshot', cols, rows, data: snapshot, theme: terminalTheme() }))
        if (pane.__trSize) conn.send(JSON.stringify({ type: 'size', ...pane.__trSize }))
        buffered.forEach(d => conn.send(Buffer.from(d)))
        live = true
        // Opening a tab on a device counts as seeing it: tabby-groups clears its "needs you".
        groups()?.markSeen?.(tab)
    }

    // ---- HTTP ----

    const json = (res, status, body) => {
        res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
        res.end(JSON.stringify(body))
    }

    const readBody = req => new Promise((resolve, reject) => {
        let size = 0
        const chunks = []
        req.on('data', c => {
            size += c.length
            if (size > 65536) {
                reject(new Error('too large'))
                req.destroy()
            }
            chunks.push(c)
        })
        req.on('end', () => {
            try {
                resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'))
            } catch (e) {
                reject(e)
            }
        })
    })

    const deviceFor = token => {
        if (!token) return null
        const h = sha(token).toString('hex')
        const device = store.devices.find(d => d.hash === h) ?? null
        // When it was last used; saved at most once a minute per device.
        if (device) {
            const now = Date.now()
            if (now - (device.lastSeen ?? 0) > 60000) {
                device.lastSeen = now
                save()
            }
        }
        return device
    }

    const locked = addr => (fails.get(addr)?.until ?? 0) > Date.now()
    function fail (addr) {
        const now = Date.now()
        const f = fails.get(addr) ?? { times: [], until: 0 }
        f.times = f.times.filter(t => now - t < 60000).concat(now)
        if (f.times.length >= 5) {
            f.until = now + 60000
            f.times = []
        }
        fails.set(addr, f)
    }

    /** Unpairs a device: its token stops working, and its open connections close (its page shows sign-in). */
    function removeDevice (gone) {
        store.devices = store.devices.filter(d => d !== gone)
        save()
        for (const c of [...clients, ...eventClients]) {
            if (c.device.id === gone.id) c.conn.close(4001)
        }
    }

    // ---- Forgetting unused devices (a private browser tab pairs a new device every time) ----

    const DAY = 86400000
    const connectedIds = () => new Set([...clients, ...eventClients].map(c => c.device.id))
    /**
     * The devices to forget: not connected now, and either not seen for `days`, or paired over a day ago and never
     * used after the visit they paired in (a private tab that was closed). Forgetting is Remove: the token stops working.
     */
    function unusedDevices (days = store.forgetDays) {
        const live = connectedIds()
        const now = Date.now()
        return store.devices.filter(d => {
            if (live.has(d.id)) return false
            const created = Date.parse(d.created) || 0
            const seen = d.lastSeen ?? created
            const firstVisitOnly = seen - created < 15 * 60000 && now - created > DAY
            return now - seen > days * DAY || firstVisitOnly
        })
    }
    function forgetUnused (days) {
        const gone = unusedDevices(days)
        gone.forEach(removeDevice)
        return gone.length
    }
    const forgetTimer = setInterval(() => store.autoForget && forgetUnused(), 6 * 3600000)
    const forgetSoon = setTimeout(() => store.autoForget && forgetUnused(), 60000)

    function newDevice (name) {
        const token = crypto.randomBytes(32).toString('base64url')
        // The first colour no other device has, so devices stay easy to tell apart.
        const used = new Set(store.devices.map(colorOf))
        const color = DEVICE_COLORS.find(c => !used.has(c)) ?? DEVICE_COLORS[store.devices.length % DEVICE_COLORS.length]
        const device = { id: crypto.randomBytes(8).toString('hex'), name: String(name || 'Device').slice(0, 64), color, hash: sha(token).toString('hex'), created: new Date().toISOString() }
        store.devices.push(device)
        save()
        return { token, deviceId: device.id }
    }

    const hosts = () => {
        const port = listeningPort
        return new Set(['localhost', ...lanAddresses()].map(a => `${a}:${port}`))
    }
    // Host check stops DNS rebinding. Origin, when sent, must be our own page; native apps send none.
    const trusted = req => hosts().has(req.headers.host) && (!req.headers.origin || req.headers.origin === `http://${req.headers.host}`)

    // ---- QR pairing: one 6-digit code, single use, 2 minutes ----

    let pairing = null

    /** The address a phone on the same Wi-Fi can reach: 192.168.x first, then 10.x, then 172.16–31.x. */
    const phoneAddress = () => {
        const a = lanAddresses().filter(x => x !== '127.0.0.1')
        return a.find(x => x.startsWith('192.168.')) ?? a.find(x => x.startsWith('10.')) ?? a[0] ?? '127.0.0.1'
    }

    function newPairing () {
        const code = String(crypto.randomInt(0, 1e6)).padStart(6, '0')
        pairing = { code, expires: Date.now() + 120000, url: `http://${phoneAddress()}:${listeningPort}/#pair=${code}` }
        return pairing
    }

    // A used code still works for 30 s, because a phone can load the QR link twice (preview, then tab).
    // The 2-minute life still caps it.
    function pair (code) {
        const ok = !!pairing && pairing.expires > Date.now() && crypto.timingSafeEqual(sha(String(code ?? '')), sha(pairing.code))
        if (ok) pairing.expires = Math.min(pairing.expires, pairing.usedUntil ??= Date.now() + 30000)
        return ok
    }

    const qrAsks = new Map()
    let overlay = null
    function closeQr () {
        // A code nobody used dies with the popup; a used one keeps its 30 s grace.
        if (overlay && pairing && !pairing.usedUntil) pairing = null
        clearInterval(overlay?.timer)
        overlay?.el.remove()
        overlay = null
    }

    function showQr () {
        if (!store.enabled) return notifications.notice('Phone access is off: turn it on in Settings > Phone access')
        closeQr()
        const el = document.createElement('div')
        el.style.cssText = 'position:fixed;inset:0;z-index:10000;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.6);font:14px system-ui,sans-serif;color:#eee'
        const card = document.createElement('div')
        card.style.cssText = 'background:#1f1f1f;border:1px solid #333;border-radius:10px;padding:20px 24px;text-align:center;box-shadow:0 8px 24px rgba(0,0,0,.5);max-width:340px'
        el.appendChild(card)
        el.addEventListener('mousedown', e => e.target === el && closeQr())
        overlay = { el, timer: null }

        // The QR is drawn once per code and stays still (a camera cannot lock onto one that is redrawn); only the
        // countdown changes each second. Dark modules on white, 8 px each, with the 4-module white margin readers need.
        let shown = null
        const render = () => {
            // A code already used gets replaced, so the QR on screen is always a fresh one.
            if (!pairing || pairing.expires <= Date.now() || pairing.usedUntil) newPairing()
            const left = Math.max(0, Math.ceil((pairing.expires - Date.now()) / 1000))
            const countdown = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`
            if (shown === pairing.code) {
                card.querySelector('[data-left]').textContent = countdown
                return
            }
            shown = pairing.code
            const qr = require('qrcode-generator')(0, 'M')
            qr.addData(pairing.url)
            qr.make()
            card.innerHTML = `<div style="font-weight:600;font-size:15px;margin-bottom:12px">Phone access</div>
                <div style="background:#fff;border-radius:6px;display:inline-block;line-height:0">${qr.createSvgTag({ cellSize: 8, margin: 4, scalable: false })}</div>
                <div style="margin-top:12px;color:#aaa"><b style="color:#eee;letter-spacing:2px">${pairing.code}</b> · <span data-left>${countdown}</span></div>
                <div style="margin-top:6px;color:#888;font-size:12px;user-select:text">${pairing.url.split('#')[0]}</div>`
            const close = document.createElement('button')
            close.textContent = 'Close'
            close.style.cssText = 'margin-top:14px;padding:6px 16px;border-radius:6px;border:1px solid #444;background:#2b2b2b;color:#eee;cursor:pointer'
            close.onclick = closeQr
            card.appendChild(close)
        }
        render()
        overlay.timer = setInterval(render, 1000)
        document.body.appendChild(el)
    }

    // ---- Page ----

    const STATIC = {
        '/': 'web/index.html',
        '/app.js': 'web/app.js',
        '/app.css': 'web/app.css',
        '/xterm.js': 'node_modules/@xterm/xterm/lib/xterm.js',
        '/xterm.css': 'node_modules/@xterm/xterm/css/xterm.css',
        '/addon-fit.js': 'node_modules/@xterm/addon-fit/lib/addon-fit.js',
        '/addon-search.js': 'node_modules/@xterm/addon-search/lib/addon-search.js',
        '/jsqr.js': 'node_modules/jsqr/dist/jsQR.js',
        '/manifest.webmanifest': 'web/manifest.webmanifest',
        '/icon-180.png': 'web/icon-180.png',
        '/icon-512.png': 'web/icon-512.png',
    }
    const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.webmanifest': 'application/manifest+json', '.png': 'image/png' }

    let icons = {}
    try {
        icons = require('tabby-groups/icons')
    } catch { }

    // ---- Files ----

    const inside = (root, p) => {
        const rel = path.relative(root, p)
        return !rel.startsWith('..') && !path.isAbsolute(rel)
    }

    async function listDir (p) {
        const roots = await Promise.all((store.fsRoots ?? []).map(r => fs.promises.realpath(r).catch(() => null)))
        const allowed = roots.filter(Boolean)
        if (!p) return allowed.map(r => ({ name: r, type: 'dir', size: 0, mtime: null }))
        // Touch nothing when files are off, and never a network path: resolving \\host\share would send
        // Windows' NTLM login to that host.
        if (!allowed.length || /^[\\/]{2}/.test(p)) return null
        // realpath resolves `..` and links before the check, so neither can leave a root.
        const real = await fs.promises.realpath(path.resolve(p)).catch(() => null)
        if (!real || !allowed.some(r => inside(r, real))) return null
        const entries = await fs.promises.readdir(real, { withFileTypes: true })
        return Promise.all(entries.map(async e => {
            const st = await fs.promises.stat(path.join(real, e.name)).catch(() => null)
            return { name: e.name, type: st?.isDirectory() ? 'dir' : 'file', size: st?.size ?? 0, mtime: st?.mtime.toISOString() ?? null }
        }))
    }

    // ---- Sessions: create, change, close ----

    const groups = () => window.__tabbyGroups
    const tabById = id => app.tabs.find(t => t.__trId === id)
    // Settings and other non-terminal tabs are not sessions.
    const terminalTabs = () => app.tabs.filter(t => panesOf(t).length)

    // For an API call that runs a command without naming a shell: the user's own shell on macOS and Linux; on Windows,
    // PowerShell 7 when installed, else Windows PowerShell, which every Windows has.
    const win = process.platform === 'win32'
    const defaultShell = !win ? process.env.SHELL || '/bin/sh'
        : require('child_process').spawnSync('where', ['pwsh.exe'], { windowsHide: true }).status === 0 ? 'pwsh.exe' : 'powershell.exe'
    const defaultArgs = win ? ['-NoLogo'] : []

    async function openSession ({ profile, command, args, cwd, run, title, group, parent }) {
        let tab
        if (profile) {
            const p = (await profiles.getProfiles()).find(x => x.id === profile || x.name === profile)
            if (!p) return null
            const inner = await profiles.openNewTabForProfile(p)
            tab = inner && (app.getParentTab(inner) ?? inner)
            if (tab && title) tab.setCustomTitle(title)
            if (tab && group) groups()?.addTab(tab, group, parent !== undefined ? { parent } : {})
        } else if (!command && !run) {
            // A plain new tab opens the default profile, exactly as Tabby's own + does (and tabby-groups' group +).
            const inner = await injector.get(require('tabby-local').TerminalService).openTab(undefined, cwd)
            tab = inner && (app.getParentTab(inner) ?? inner)
            if (tab && title) tab.setCustomTitle(title)
            if (tab && group) groups()?.addTab(tab, group, parent !== undefined ? { parent } : {})
        } else if (groups()) {
            // Always name the shell: tabby-groups' own default, `pwsh.exe`, is missing on a Mac and on many PCs.
            const index = await groups().open({ title, command: command ?? defaultShell, args: args ?? (command ? [] : defaultArgs), cwd, run, group, parent })
            tab = app.tabs[index - 1]
        } else {
            // Without tabby-groups, `run` and `group` are ignored.
            const inner = await profiles.openNewTabForProfile({ type: 'local', name: title ?? command ?? 'Shell', options: { command: command ?? defaultShell, args: args ?? (command ? [] : defaultArgs), cwd, env: {} } })
            tab = inner && (app.getParentTab(inner) ?? inner)
            if (tab && title) tab.setCustomTitle(title)
        }
        return tab ?? null
    }

    function changeSession (tab, { title, group, parent, pinned, focus }) {
        // An empty title clears the custom one, so the shell's own title shows again.
        if (typeof title === 'string') tab.setCustomTitle(title)
        if (group === null) groups()?.removeTab(tab)
        else if (typeof group === 'string') groups()?.addTab(tab, group, parent !== undefined ? { parent } : {})
        // tabby-groups pins inside the tab's group, or with Tabby's own pin when the tab is loose.
        if (typeof pinned === 'boolean') groups()?.setTabPinned(tab, pinned)
        if (focus) app.selectTab(tab)
        setTimeout(tick)
    }

    // ---- Events: diff the session list each second and on Tabby's own signals ----
    // Polling catches the cwd and icon changes tabby-groups makes without an event. Subscribe per field if CPU matters.

    const eventClients = new Set()
    let lastSessions = null
    let lastGroups = null

    function tick () {
        if (!eventClients.size) {
            lastSessions = lastGroups = null
            return
        }
        const now = new Map(terminalTabs().map(t => {
            const s = session(t)
            return [s.id, { s, json: JSON.stringify(s) }]
        }))
        const g = groups()?.list() ?? []
        const gJson = JSON.stringify(g)
        const out = []
        if (lastSessions) {
            for (const [id, { s, json }] of now) {
                if (!lastSessions.has(id)) out.push({ type: 'opened', session: s })
                else if (lastSessions.get(id).json !== json) out.push({ type: 'changed', session: s })
            }
            for (const id of lastSessions.keys()) {
                if (!now.has(id)) out.push({ type: 'closed', id })
            }
            if (gJson !== lastGroups) out.push({ type: 'groups', groups: g })
        }
        lastSessions = now
        lastGroups = gJson
        for (const m of out) eventClients.forEach(c => c.conn.send(JSON.stringify(m)))
    }
    const timer = setInterval(tick, 500)
    const tabbySubs = [app.tabsChanged$, app.activeTabChange$].map(o => o.subscribe(() => setTimeout(tick)))
    // A new colour scheme in Tabby's settings reaches the attached pages at once.
    let themeJson = 'null'
    tabbySubs.push(config.changed$.subscribe(() => {
        const json = JSON.stringify(terminalTheme())
        if (json === themeJson) return
        themeJson = json
        for (const c of clients) c.conn.send(`{"type":"theme","theme":${json}}`)
    }))
    // tabby-groups says when a Claude tab turns busy or waiting: pass it on at once.
    const onAgent = () => setTimeout(tick)
    window.addEventListener('tabby-groups:agent', onAgent)

    async function handle (req, res) {
        if (!trusted(req)) return json(res, 403, { error: 'forbidden' })
        const url = new URL(req.url, 'http://x')
        const addr = req.socket.remoteAddress
        const at = (method, re) => req.method === method && re.exec(url.pathname)
        let m

        if (req.method === 'GET' && STATIC[url.pathname]) {
            res.writeHead(200, {
                'Content-Type': TYPES[path.extname(STATIC[url.pathname])],
                'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'",
                'X-Content-Type-Options': 'nosniff',
                'Cache-Control': 'no-cache',
            })
            // The page and its manifest carry this computer's name, so each computer's Home Screen icon is named after it.
            if (url.pathname === '/' || url.pathname === '/manifest.webmanifest') {
                const named = fs.readFileSync(path.join(__dirname, STATIC[url.pathname]), 'utf8').replaceAll('{{computer}}', escapeHtml(computerName()))
                return res.end(named)
            }
            return fs.createReadStream(path.join(__dirname, STATIC[url.pathname])).pipe(res)
        }

        if (at('POST', /^\/api\/pair$/)) {
            if (locked(addr)) return json(res, 429, { error: 'locked' })
            const body = await readBody(req).catch(() => null)
            if (!body) return json(res, 400, { error: 'bad body' })
            if (!pair(body.code)) {
                fail(addr)
                return json(res, 401, { error: 'wrong or expired code' })
            }
            const result = newDevice(body.deviceName)
            closeQr()
            notifications.notice(`${String(body.deviceName || 'Device').slice(0, 64)} paired`)
            return json(res, 200, result)
        }

        if (at('POST', /^\/api\/qr$/)) {
            // Show the pairing QR on this Tabby's screen, asked for by a device (one not yet signed in, or one
            // pairing another). No sign-in needed: it only shows the code on the PC, where pairing already
            // requires being. Once per 10 s per address, so nobody can keep popping it up.
            const last = qrAsks.get(addr) ?? 0
            if (Date.now() - last < 10000) return json(res, 429, { error: 'wait a moment' })
            qrAsks.set(addr, Date.now())
            showQr()
            return json(res, 200, {})
        }

        if (req.method === 'GET' && url.pathname === '/api/info') {
            // groups: tabby-groups is installed, so groups, pins and drag and drop are available.
            // id, name, port: which computer this is, for a client that knows several.
            return json(res, 200, { tabby: injector.get(core.PlatformService).getAppVersion(), plugin: VERSION, host: os.hostname(), id: store.computerId, name: computerName(), port: listeningPort, password: !!store.passwordHash, groups: !!groups() })
        }

        if (req.method === 'POST' && url.pathname === '/api/login') {
            if (locked(addr)) return json(res, 429, { error: 'locked' })
            const body = await readBody(req).catch(() => null)
            if (!body) return json(res, 400, { error: 'bad body' })
            const ok = passwordOk(body.password)
            if (!ok) {
                fail(addr)
                return json(res, 401, { error: 'wrong password' })
            }
            return json(res, 200, newDevice(body.deviceName))
        }

        const device = deviceFor(req.headers.authorization?.replace(/^Bearer /, ''))
        if (!device) return json(res, 401, { error: 'unauthorized' })

        // A signed-in device lets another one pair (a phone adding an iPad): the same single-use, 2-minute code as
        // Tabby's QR button, with its QR drawn here. Only for a device that already has a token, so there is always
        // existing trust; the new device gets its own token, removable like any other.
        // The other computers running tabby-remote on this network (see "Other computers"): { computerId, name, url }.
        if (at('GET', /^\/api\/computers$/)) {
            return json(res, 200, otherComputers())
        }
        if (at('POST', /^\/api\/pairing$/)) {
            const p = newPairing()
            const qr = require('qrcode-generator')(0, 'M')
            qr.addData(p.url)
            qr.make()
            notifications.notice(`${device.name} is adding a device`)
            return json(res, 200, { code: p.code, url: p.url, expires: p.expires, svg: qr.createSvgTag({ cellSize: 6, margin: 4, scalable: true }) })
        }
        if (at('GET', /^\/api\/devices$/)) {
            return json(res, 200, store.devices.map(({ hash, ...d }) => ({ ...d, color: colorOf(d), current: d.id === device.id })))
        }
        if ((m = at('DELETE', /^\/api\/devices\/([^/]+)$/))) {
            const gone = store.devices.find(d => d.id === m[1])
            if (!gone) return json(res, 404, { error: 'not found' })
            removeDevice(gone)
            return json(res, 200, {})
        }
        if (at('POST', /^\/api\/upload$/)) {
            // A file from the device (photo, screenshot, any file), saved to a temp folder on this PC; the device
            // then pastes its path into the terminal (Claude Code attaches an image given its path).
            // Files stay in the OS temp folder; clear tabby-remote\uploads there if it ever grows.
            const name = path.basename(decodeURIComponent(req.headers['x-filename'] ?? 'file')).replace(/[^\w.\- ]+/g, '_').slice(-120) || 'file'
            const dir = path.join(os.tmpdir(), 'tabby-remote', 'uploads')
            await fs.promises.mkdir(dir, { recursive: true })
            const file = path.join(dir, `${Date.now()}-${name}`)
            const ok = await new Promise(resolve => {
                let size = 0
                const out = fs.createWriteStream(file)
                req.on('data', c => {
                    size += c.length
                    if (size > MAX_UPLOAD) {
                        req.destroy()
                        out.destroy()
                        fs.promises.rm(file, { force: true })
                        resolve(false)
                    }
                })
                req.pipe(out)
                out.on('finish', () => resolve(true))
                out.on('error', () => resolve(false))
            })
            return ok ? json(res, 200, { path: file }) : json(res, 413, { error: 'too large or failed' })
        }
        if (at('GET', /^\/api\/clipboard$/)) {
            // The PC's clipboard: its text, or an image saved to the uploads folder (pasted on the device as a path).
            const { clipboard } = require('electron')
            const image = clipboard.readImage()
            if (!image.isEmpty()) {
                const dir = path.join(os.tmpdir(), 'tabby-remote', 'uploads')
                await fs.promises.mkdir(dir, { recursive: true })
                const file = path.join(dir, `${Date.now()}-clipboard.png`)
                await fs.promises.writeFile(file, image.toPNG())
                return json(res, 200, { text: null, path: file })
            }
            return json(res, 200, { text: clipboard.readText(), path: null })
        }
        if (at('PUT', /^\/api\/clipboard$/)) {
            const body = await readBody(req).catch(() => null)
            if (typeof body?.text !== 'string') return json(res, 400, { error: 'text needed' })
            require('electron').clipboard.writeText(body.text)
            return json(res, 200, {})
        }
        if (at('GET', /^\/api\/profiles$/)) {
            return json(res, 200, (await profiles.getProfiles()).map(p => ({ id: p.id ?? null, name: p.name, type: p.type, icon: p.icon ?? null })))
        }
        if (at('GET', /^\/api\/fs$/)) {
            const entries = await listDir(url.searchParams.get('path'))
            return entries ? json(res, 200, entries) : json(res, 403, { error: 'outside allowed roots' })
        }
        if (at('GET', /^\/api\/sessions$/)) {
            return json(res, 200, terminalTabs().map(session))
        }
        if ((m = at('GET', /^\/api\/sessions\/([^/]+)\/peek$/))) {
            // Peek: the last lines on the tab's screen (its focused pane), as plain text, without attaching.
            const tab = tabById(m[1])
            if (!tab) return json(res, 404, { error: 'not found' })
            const pane = tab.focusedTab ?? panesOf(tab)[0]
            const xterm = pane?.frontend?.xterm
            if (!xterm) return json(res, 200, { lines: [] })
            const b = xterm.buffer.active
            const lines = []
            for (let y = b.baseY; y < b.baseY + xterm.rows; y++) lines.push(b.getLine(y)?.translateToString(true) ?? '')
            while (lines.length && !lines.at(-1).trim()) lines.pop()
            const n = Math.min(Math.max(parseInt(url.searchParams.get('lines')) || 12, 1), 60)
            return json(res, 200, { lines: lines.slice(-n) })
        }
        if (at('POST', /^\/api\/move$/)) {
            // Drag and drop in the sidebar: tabby-groups applies it with its own rules.
            const body = await readBody(req).catch(() => null)
            if (!body) return json(res, 400, { error: 'bad body' })
            if (typeof groups()?.drop !== 'function') return json(res, 501, { error: 'needs tabby-groups with drop()' })
            const side = x => x?.session ? tabById(String(x.session)) ?? null : x?.group ? { group: String(x.group) } : null
            const ok = groups().drop(side(body.source), side(body.target), body.where)
            return ok ? json(res, 200, {}) : json(res, 409, { error: 'not allowed there' })
        }
        if ((m = at('PATCH', /^\/api\/groups\/([^/]+)$/)) || (m = at('POST', /^\/api\/groups\/([^/]+)\/ungroup$/))) {
            // Group actions from the sidebar menu, applied by tabby-groups' own functions.
            const tg = groups()
            if (!tg) return json(res, 501, { error: 'needs tabby-groups' })
            const name = decodeURIComponent(m[1])
            if (!tg.list().some(g => g.name === name)) return json(res, 404, { error: 'no such group' })
            if (req.method === 'POST') {
                tg.ungroup(name)
                setTimeout(tick)
                return json(res, 200, {})
            }
            const body = await readBody(req).catch(() => null)
            if (!body) return json(res, 400, { error: 'bad body' })
            let ok = true
            if ('color' in body) tg.setColor(name, body.color ?? null)
            if ('collapsed' in body) tg.setCollapsed(name, !!body.collapsed)
            if ('pinned' in body) ok = tg.setPinned(name, !!body.pinned) !== false && ok
            if ('parent' in body) ok = tg.setParent(name, body.parent ?? null) !== false && ok
            let now = name
            if (typeof body.name === 'string' && body.name.trim() && body.name !== name) {
                if (tg.rename(name, body.name.trim())) now = body.name.trim()
                else ok = false
            }
            setTimeout(tick)
            return json(res, ok ? 200 : 409, tg.list().find(g => g.name === now) ?? {})
        }
        if (at('GET', /^\/api\/groups$/)) {
            return json(res, 200, groups()?.list() ?? [])
        }
        if (at('GET', /^\/api\/icons$/)) {
            // Built-in icons, plus the user's own from tabby-groups' settings (kind "user:<name>", maybe an emoji).
            const own = groups()?.icons?.() ?? []
            return json(res, 200, { ...icons, ...Object.fromEntries(own.map(i => [i.kind, i])) })
        }
        if (at('POST', /^\/api\/sessions$/)) {
            const body = await readBody(req).catch(() => null)
            if (!body) return json(res, 400, { error: 'bad body' })
            const tab = await openSession(body)
            return tab ? json(res, 200, session(tab)) : json(res, 400, { error: 'could not open' })
        }
        if ((m = at('PATCH', /^\/api\/sessions\/([^/]+)$/))) {
            const tab = tabById(m[1])
            if (!tab) return json(res, 404, { error: 'not found' })
            const body = await readBody(req).catch(() => null)
            if (!body) return json(res, 400, { error: 'bad body' })
            changeSession(tab, body)
            return json(res, 200, session(tab))
        }
        if ((m = at('DELETE', /^\/api\/sessions\/([^/]+)$/))) {
            const tab = tabById(m[1])
            if (!tab) return json(res, 404, { error: 'not found' })
            await app.closeTab(tab, false)
            return app.tabs.includes(tab) ? json(res, 409, { error: 'tab is pinned' }) : json(res, 200, {})
        }
        json(res, 404, { error: 'not found' })
    }

    function upgrade (req, socket) {
        const p = new URL(req.url, 'http://x').pathname
        const m = /^\/api\/sessions\/([^/]+)\/panes\/([^/]+)\/attach$/.exec(p)
        if ((!m && p !== '/api/events') || !trusted(req)) return socket.end('HTTP/1.1 403 Forbidden\r\n\r\n')
        const conn = ws.accept(req, socket)
        if (!conn) return
        const timer = setTimeout(() => conn.close(4001), 5000)
        conn.onMessage(inZone(text => {
            clearTimeout(timer)
            conn.onMessage(() => {})
            let msg = null
            try {
                msg = JSON.parse(text)
            } catch { }
            const device = msg?.type === 'auth' && deviceFor(msg.token)
            if (!device) return conn.close(4001)
            if (!m) {
                const client = { conn, device }
                eventClients.add(client)
                conn.onClose(() => eventClients.delete(client))
                return tick()
            }
            const tab = tabById(m[1])
            const pane = tab && panesOf(tab).find(x => x.__trId === m[2])
            if (!pane) return conn.close(4004)
            attach(conn, device, tab, pane).catch(e => {
                console.error('[tabby-remote] attach', e)
                conn.close(1011)
            })
        }))
    }

    // Listens on the addresses present when it starts; restart Tabby (or turn it off and on) after joining a new network.
    let servers = []
    /** Whether nothing else listens on `port` here (another Tabby on this computer takes the same default). */
    const portFree = port => new Promise(resolve => {
        const probe = http.createServer()
        probe.once('error', () => resolve(false))
        probe.once('listening', () => probe.close(() => resolve(true)))
        probe.listen(port, '127.0.0.1')
    })
    async function startServers () {
        if (servers.length) return
        await previous
        if (disposed) return
        // The set port, else the next free one of the 10 after it, kept as this Tabby's port so its links still work.
        let port = store.port
        while (!(await portFree(port)) && port < store.port + 10) port++
        if (servers.length) return
        if (port !== store.port) {
            console.warn(`[tabby-remote] port ${store.port} is taken; using ${port}`)
            store.port = port
            save()
        }
        listeningPort = port
        servers = lanAddresses().map(addr => {
            const s = http.createServer(inZone((req, res) => handle(req, res).catch(e => {
                console.error('[tabby-remote]', e)
                json(res, 500, { error: 'internal' })
            })))
            s.on('upgrade', inZone(upgrade))
            s.on('error', e => console.warn(`[tabby-remote] ${addr}:${listeningPort}`, e.message))
            s.listen(listeningPort, addr)
            return s
        })
    }
    /** Phone access off: nothing listens on the network and every device is disconnected; they stay paired. */
    function stopServers () {
        closeQr()
        ;[...clients, ...eventClients].forEach(c => c.conn.close(1001))
        servers.forEach(s => s.close())
        servers = []
    }
    if (store.enabled) startServers()

    // ---- Other computers: each Tabby announces itself on the local network, and hears the others ----
    // A small UDP broadcast every 30 s on a fixed port: { app, v, computerId, name, port }. Nothing secret: signing in
    // to another computer still needs its own code or password. Only our own format and version are accepted. Where
    // a firewall blocks it, it fails quietly and the phone's list of computers is just empty.
    const ANNOUNCE_PORT = 41681
    const peers = new Map()
    const dgram = require('dgram')
    const announcer = dgram.createSocket({ type: 'udp4', reuseAddr: true })
    announcer.on('error', e => console.warn('[tabby-remote] announce', e.message))
    announcer.on('message', (buf, from) => {
        let m
        try {
            m = JSON.parse(buf.toString('utf8'))
        } catch {
            return
        }
        if (m?.app !== 'tabby-remote' || m.v !== 1 || typeof m.computerId !== 'string' || m.computerId === store.computerId) return
        if (!Number.isInteger(m.port) || m.port < 1 || m.port > 65535) return
        // Its address is the one the message came from: an IP change is followed on the next announcement.
        peers.set(m.computerId, { computerId: m.computerId, name: String(m.name ?? '').slice(0, 40) || from.address, url: `http://${from.address}:${m.port}/`, seen: Date.now() })
    })
    /** The broadcast address (from its netmask) of the network phones use, the Wi-Fi one (see phoneAddress), only:
     *  not a virtual one (Hyper-V, WSL, VPN), whose address another computer could not reach. */
    const broadcastAddresses = () => Object.values(os.networkInterfaces()).flat()
        .filter(a => a.family === 'IPv4' && !a.internal && a.address === phoneAddress())
        .map(a => a.address.split('.').map((o, i) => (Number(o) | (~Number(a.netmask.split('.')[i]) & 255)) & 255).join('.'))
    function announce () {
        if (!store.announce || !store.enabled || !servers.length) return
        const msg = Buffer.from(JSON.stringify({ app: 'tabby-remote', v: 1, computerId: store.computerId, name: computerName(), port: listeningPort }))
        for (const to of broadcastAddresses()) announcer.send(msg, ANNOUNCE_PORT, to, () => {})
    }
    announcer.bind(ANNOUNCE_PORT, () => {
        try {
            announcer.setBroadcast(true)
        } catch { }
        announce()
    })
    const announceTimer = setInterval(announce, 30000)
    /** The other computers heard from in the last 2 minutes. */
    const otherComputers = () => [...peers.values()].filter(p => Date.now() - p.seen < 120000).map(({ seen, ...p }) => p)

    // ---- Settings > Phone access ----

    /** Fills Tabby's settings tab, in the look of Tabby's own (form-line rows, Bootstrap controls). */
    function renderSettings (host) {
        const h = (tag, props = {}, ...kids) => {
            const e = Object.assign(document.createElement(tag), props)
            e.append(...kids.filter(k => k != null))
            return e
        }
        const rerender = () => renderSettings(host)
        // Tabby's own row: title and description on the left, the control in the right column (Tabby's CSS sizes a
        // form-control there; extra buttons sit to its left, so every field and toggle shares one right edge).
        const line = (title, description, control, ...before) => {
            const note = h('span', { className: 'ms-2 text-success' })
            const row = h('div', { className: 'form-line' },
                h('div', { className: 'header' }, h('div', { className: 'title' }, title, note), description && h('div', { className: 'description', textContent: description })),
                before.length ? h('div', { className: 'd-flex align-items-center gap-2' }, ...before, control) : control)
            row.saved = () => {
                note.textContent = '✓ Saved'
                setTimeout(() => { note.textContent = '' }, 1500)
            }
            return row
        }
        // Tabby's right-column field width, also for a field that shares its row with buttons.
        const FIELD = 'width:198px;flex:none'
        const toggle = (on, change) => h('div', { className: 'form-check form-switch ms-auto mb-0' },
            h('input', { className: 'form-check-input', type: 'checkbox', role: 'switch', checked: on, onchange: e => change(e.target.checked) }))
        const button = (text, onclick) => h('button', { className: 'btn btn-secondary text-nowrap', textContent: text, onclick })
        /** A field saved on Enter or on leaving it, with a short "Saved" next to its title. */
        const field = (props, apply) => {
            const input = h('input', { className: 'form-control', style: FIELD, ...props })
            let row
            const commit = () => {
                if (apply(input.value) !== false) {
                    save()
                    row?.saved()
                }
            }
            input.addEventListener('change', commit)
            input.addEventListener('keydown', e => e.key === 'Enter' && input.blur())
            return { input, attach: r => (row = r) }
        }

        const address = `http://${phoneAddress()}:${listeningPort}`
        const addressBox = h('input', { className: 'form-control', style: FIELD, type: 'text', readOnly: true, value: address })

        const port = field({ type: 'number', min: 1024, max: 65535, value: store.port }, v => {
            const n = Math.round(Number(v))
            if (!(n >= 1024 && n <= 65535)) return false
            store.port = n
            rerender()
        })
        const name = field({ type: 'text', value: store.name ?? '', placeholder: os.hostname(), maxLength: 40 }, v => {
            store.name = v.trim().slice(0, 40) || null
        })
        const minutes = field({ type: 'number', min: 0, max: 1440, value: store.awakeMinutes, disabled: !store.keepAwake && !store.keepScreen }, v => {
            store.awakeMinutes = Math.max(0, Math.min(1440, Math.round(Number(v) || 0)))
        })
        // The password is never shown or echoed back: the field is only for typing a new one.
        const pw = h('input', { className: 'form-control', style: FIELD, type: 'password', placeholder: store.passwordHash ? 'Set' : 'Not set', autocomplete: 'new-password' })
        const setPassword = () => {
            if (!pw.value) return
            store.passwordHash = hashPassword(pw.value)
            save()
            rerender()
        }
        pw.addEventListener('keydown', e => e.key === 'Enter' && setPassword())

        const live = new Set([...clients, ...eventClients].map(c => c.device.id))
        const portRow = line('Port', listeningPort === store.port ? 'Applies after restarting Tabby.' : `Applies after restarting Tabby. Still on ${listeningPort} until then.`, port.input)
        port.attach(portRow)
        const nameRow = line('Computer name', 'What phones call this computer: their header and its Home Screen icon (add the icon again after a change).', name.input)
        name.attach(nameRow)
        const days = field({ type: 'number', min: 1, max: 365, value: store.forgetDays, disabled: !store.autoForget }, v => {
            store.forgetDays = Math.max(1, Math.min(365, Math.round(Number(v) || 30)))
        })
        const daysRow = line('Days unused before forgetting', null, days.input)
        days.attach(daysRow)
        const ago = t => {
            const m = Math.round((Date.now() - (t ?? 0)) / 60000)
            return m < 2 ? 'just now' : m < 60 ? `${m} min ago` : m < 48 * 60 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`
        }
        const minutesRow = line('Minutes awake after the last device leaves', 'A phone that locks drops its connection; this keeps the PC reachable when it comes back.', minutes.input)
        minutes.attach(minutesRow)

        host.replaceChildren(
            h('h3', { className: 'mb-3', textContent: 'Connection' }),
            line('Phone access', 'Off: nothing listens on the network and connected devices are dropped. They stay paired.',
                toggle(store.enabled, on => {
                    store.enabled = on
                    save()
                    if (on) startServers().then(rerender)
                    else stopServers()
                    rerender()
                })),
            line('Address', 'Open it on a phone or tablet on the same Wi-Fi, or scan the QR.', addressBox,
                button('Copy', e => {
                    require('electron').clipboard.writeText(address)
                    e.target.textContent = 'Copied'
                    setTimeout(() => { e.target.textContent = 'Copy' }, 1200)
                }),
                button('Show QR', () => showQr())),
            portRow,
            line('Show this computer to my other computers', `Lets a phone signed in to another computer on this Wi-Fi list this one (signing in here still needs its own code). ${otherComputers().length ? `Seen now: ${otherComputers().map(p => p.name).join(', ')}.` : 'No other computers seen right now.'}`,
                toggle(store.announce, on => {
                    store.announce = on
                    save()
                    announce()
                })),

            h('h3', { className: 'mt-4 mb-3', textContent: 'This computer' }),
            nameRow,

            h('h3', { className: 'mt-4 mb-3', textContent: 'Security' }),
            line('Password', store.passwordHash ? 'Sign in with this password instead of a QR code. Type a new one to change it.' : 'Optional: sign in with a password instead of a QR code.', pw,
                button('Set', setPassword),
                store.passwordHash ? button('Remove', () => {
                    store.passwordHash = null
                    save()
                    rerender()
                }) : null),
            line('Forget unused devices', 'A private browser tab pairs as a new device each time. Forgotten: devices not seen for the days below, and ones never used after the visit they paired in (after a day). Never one connected now.',
                toggle(store.autoForget, on => {
                    store.autoForget = on
                    save()
                    days.input.disabled = !on
                    if (on) forgetUnused()
                    rerender()
                })),
            daysRow,
            line('Paired devices', 'Remove one to sign it out at once.', button(`Remove unused (${unusedDevices().length})`, () => {
                forgetUnused()
                rerender()
            })),
            store.devices.length
                ? h('div', { className: 'list-group mb-3' }, ...[...store.devices].sort((a, b) => (b.lastSeen ?? 0) - (a.lastSeen ?? 0)).map(d => h('div', { className: 'list-group-item d-flex align-items-center' },
                    h('span', { style: `display:inline-block;flex:none;width:10px;height:10px;border-radius:50%;margin-right:10px;background:${colorOf(d)}` }),
                    h('div', { className: 'me-auto' },
                        h('div', { textContent: d.name }),
                        h('small', { className: 'text-muted', textContent: `Paired ${new Date(d.created).toLocaleDateString()} · ${live.has(d.id) ? 'connected now' : `last seen ${ago(d.lastSeen)}`}` })),
                    h('button', {
                        className: 'btn btn-outline-danger btn-sm', textContent: 'Remove',
                        onclick: () => {
                            removeDevice(d)
                            rerender()
                        },
                    }))))
                : h('p', { className: 'text-muted', textContent: 'None yet. Scan the QR on a phone to add one.' }),

            h('h3', { className: 'mt-4 mb-3', textContent: 'Power' }),
            line('Keep this PC awake', 'While a device has a tab open, the PC does not go to sleep. The screen may still turn off.',
                toggle(store.keepAwake, on => {
                    store.keepAwake = on
                    save()
                    stayAwake()
                    minutes.input.disabled = !on && !store.keepScreen
                })),
            line('Keep the screen on while a device is connected', 'Stops the screen turning off, and with it the lock and standby that can pause Tabby on a laptop. Your PC stays unlocked and unattended while connected.',
                toggle(!!store.keepScreen, on => {
                    store.keepScreen = on
                    save()
                    stayAwake()
                    minutes.input.disabled = !on && !store.keepAwake
                })),
            minutesRow,
        )
    }

    window.__tabbyRemote = {
        version: VERSION,
        storePath,
        showQr: inZone(showQr),
        clients: () => [...clients].map(c => ({ device: c.device.name, pane: c.pane.__trId })),
        awake: () => awake !== null && powerSaveBlocker.isStarted(awake),
        screenOn: () => screenOn !== null && powerSaveBlocker.isStarted(screenOn),
        renderSettings: inZone(renderSettings),
        /** Loads this plugin's files again from disk and swaps the running instance for the new one. */
        reload () {
            Object.keys(require.cache).filter(f => f.startsWith(__dirname + path.sep)).forEach(f => delete require.cache[f])
            return require(__filename).install(injector)
        },
        /** Stops everything this instance started; resolves once its servers have released the port. */
        dispose () {
            disposed = true
            clearTimeout(forgetSoon)
            closeQr()
            letSleep()
            clearInterval(timer)
            clearInterval(presenceTimer)
            window.removeEventListener('tabby-groups:agent', onAgent)
            app.tabs.forEach(t => { delete t.__trPresence })
            window.dispatchEvent(new CustomEvent('tabby-remote:presence'))
            tabbySubs.forEach(s => s.unsubscribe())
            ;[...clients, ...eventClients].forEach(c => c.conn.close(1001))
            const closed = servers.map(s => new Promise(resolve => {
                s.close(resolve)
                s.closeAllConnections?.()
            }))
            servers = []
            clearInterval(announceTimer)
            clearInterval(forgetTimer)
            try {
                announcer.close()
            } catch { }
            delete window.__tabbyRemote
            // Never waits long: a socket that will not close does not hold up the next instance.
            return Promise.race([Promise.all(closed), new Promise(resolve => setTimeout(resolve, 2000))])
        },
    }
    return window.__tabbyRemote
}

class TabbyRemoteModule {
    constructor (injector) {
        install(injector)
    }
}
TabbyRemoteModule.ctorParameters = () => [{ type: Injector }]

// Lucide 'qr-code' (ISC, lucide.dev).
const QR_ICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="5" height="5" x="3" y="3" rx="1"/><rect width="5" height="5" x="16" y="3" rx="1"/><rect width="5" height="5" x="3" y="16" rx="1"/><path d="M21 16h-3a2 2 0 0 0-2 2v3"/><path d="M21 21v.01"/><path d="M12 7v3a2 2 0 0 1-2 2H7"/><path d="M3 12h.01"/><path d="M12 3h.01"/><path d="M12 16v.01"/><path d="M16 12h1"/><path d="M21 12v.01"/><path d="M12 21v-1"/></svg>'

class RemoteButtonProvider extends core.ToolbarButtonProvider {
    provide () {
        return [{ icon: QR_ICON, title: 'Phone access', weight: 5, click: () => window.__tabbyRemote?.showQr() }]
    }
}

// Settings > Phone access. Tabby has no template compiler at run time, so the component is declared by hand,
// with an empty template; install() fills it with plain DOM, and a hot reload brings the new page with it.
class RemoteSettingsComponent {
    constructor (ref) {
        this.host = ref.nativeElement
    }

    ngOnInit () {
        window.__tabbyRemote?.renderSettings(this.host)
    }
}
RemoteSettingsComponent.ɵfac = () => new RemoteSettingsComponent(ɵɵdirectiveInject(ElementRef))
RemoteSettingsComponent.ɵcmp = ɵɵdefineComponent({ type: RemoteSettingsComponent, selectors: [['tabby-remote-settings']], decls: 0, vars: 0, template: () => { }, encapsulation: 2 })

const settings = require('tabby-settings')
class RemoteSettingsTabProvider extends settings.SettingsTabProvider {
    constructor () {
        super()
        this.id = 'tabby-remote'
        this.icon = 'mobile-alt'
        this.title = 'Phone access'
    }

    getComponentType () {
        return RemoteSettingsComponent
    }
}

module.exports = NgModule({
    providers: [
        { provide: core.ToolbarButtonProvider, useClass: RemoteButtonProvider, multi: true },
        { provide: settings.SettingsTabProvider, useClass: RemoteSettingsTabProvider, multi: true },
    ],
})(TabbyRemoteModule)
module.exports.default = module.exports
module.exports.install = install
