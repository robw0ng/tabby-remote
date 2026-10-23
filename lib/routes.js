const fs = require('fs')
const os = require('os')
const path = require('path')
const core = require('tabby-core')

const ROOT = path.join(__dirname, '..')
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.webmanifest': 'application/manifest+json', '.png': 'image/png' }
// The page's own files (web/), and the libraries it loads.
const STATIC = {
    '/': 'web/index.html',
    ...Object.fromEntries(fs.readdirSync(path.join(ROOT, 'web')).filter(f => TYPES[path.extname(f)] && f !== 'index.html').map(f => ['/' + f, 'web/' + f])),
    '/xterm.js': 'node_modules/@xterm/xterm/lib/xterm.js',
    '/xterm.css': 'node_modules/@xterm/xterm/css/xterm.css',
    '/addon-fit.js': 'node_modules/@xterm/addon-fit/lib/addon-fit.js',
    '/addon-search.js': 'node_modules/@xterm/addon-search/lib/addon-search.js',
    '/jsqr.js': 'node_modules/jsqr/dist/jsQR.js',
}

const escapeHtml = s => String(s).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`)

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

/** The HTTP API (see API.md) and the page. */
module.exports = ctx => {
    const { app, store, profiles, notifications, injector } = ctx

    let icons = {}
    try {
        icons = require('tabby-groups/icons')
    } catch { }

    function serveStatic (url, res) {
        const file = path.join(ROOT, STATIC[url.pathname])
        res.writeHead(200, {
            'Content-Type': TYPES[path.extname(file)],
            'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; frame-ancestors 'none'",
            'X-Content-Type-Options': 'nosniff',
            'Cache-Control': 'no-cache',
        })
        // The page and its manifest carry this computer's name, so each computer's Home Screen icon is named after it.
        if (url.pathname === '/' || url.pathname === '/manifest.webmanifest') {
            return res.end(fs.readFileSync(file, 'utf8').replaceAll('{{computer}}', escapeHtml(ctx.computerName())))
        }
        fs.createReadStream(file).pipe(res)
    }

    async function handle (req, res) {
        if (!ctx.trusted(req)) return json(res, 403, { error: 'forbidden' })
        const url = new URL(req.url, 'http://x')
        const addr = req.socket.remoteAddress
        const at = (method, re) => req.method === method && re.exec(url.pathname)
        const body = () => readBody(req).catch(() => null)
        let m

        if (req.method === 'GET' && STATIC[url.pathname]) return serveStatic(url, res)

        // ---- Without sign-in ----

        // Linking another computer sends its password or code sealed to this computer's identity (identity.js), and
        // gets its token back sealed the same way; a phone sends them as they are.
        const opened = async () => {
            const raw = await body()
            if (!raw?.sealed) return { b: raw, reply: (status, obj) => json(res, status, obj) }
            const o = ctx.openSealed(raw.sealed)
            if (!o || typeof o.body !== 'object' || !o.body) return { b: null, reply: (status, obj) => json(res, status, obj) }
            return { b: o.body, reply: (status, obj) => json(res, status, status === 200 ? o.seal(obj) : obj) }
        }

        if (at('POST', /^\/api\/identity$/)) {
            // Who this computer is, for one linking to it or checking it: its keys, signed with the asker's nonce and
            // address. Gives nothing away; the keys are public.
            const a = ctx.identityAnswer((await body())?.nonce, addr)
            return a ? json(res, 200, a) : json(res, 400, { error: 'nonce needed' })
        }
        if (at('POST', /^\/api\/pair$/)) {
            if (ctx.locked(addr)) return json(res, 429, { error: 'locked' })
            const { b, reply } = await opened()
            if (!b) return json(res, 400, { error: 'bad body' })
            if (!ctx.pair(b.code)) {
                ctx.fail(addr)
                return json(res, 401, { error: 'wrong or expired code' })
            }
            const result = ctx.newDevice(b.deviceName, b.computer === true)
            ctx.closeQr()
            notifications.notice(`${String(b.deviceName || 'Device').slice(0, 64)} paired`)
            return reply(200, result)
        }
        if (at('POST', /^\/api\/qr$/)) {
            return ctx.askQr(addr) ? json(res, 200, {}) : json(res, 429, { error: 'wait a moment' })
        }
        if (at('GET', /^\/api\/info$/)) {
            // groups: tabby-groups is installed, so groups, pins and drag and drop are available.
            // id, name, port: which computer this is, for a client that knows several. tailscale: its Tailscale name
            // (or address), where a linked computer still finds it away from this network.
            return json(res, 200, { tabby: injector.get(core.PlatformService).getAppVersion(), plugin: ctx.version, host: os.hostname(), id: store.computerId, name: ctx.computerName(), port: ctx.listeningPort, password: !!store.passwordHash, groups: !!ctx.groups(), side: ctx.tabsSide(), tailscale: await ctx.tailscaleHost() })
        }
        if (at('POST', /^\/api\/prove$/)) {
            // A linked computer checks this is really the computer it linked to before sending its token here:
            // HMAC(nonce and the address the question came from) keyed by that link's token hash, which only this
            // computer holds. The address makes a relayed question fail: a host passing it on would be the asker.
            const b = await body()
            const d = typeof b?.deviceId === 'string' && store.devices.find(x => x.computer && x.id === b.deviceId)
            if (!d || typeof b.nonce !== 'string' || b.nonce.length < 32 || b.nonce.length > 128) return json(res, 404, { error: 'not found' })
            const { sign, box } = store.identity
            return json(res, 200, { proof: ctx.proofFor(d.hash, b.nonce, addr, sign, box), sign, box })
        }
        if (at('POST', /^\/api\/login$/)) {
            if (ctx.locked(addr)) return json(res, 429, { error: 'locked' })
            const { b, reply } = await opened()
            if (!b) return json(res, 400, { error: 'bad body' })
            if (!ctx.passwordOk(b.password)) {
                ctx.fail(addr)
                return json(res, 401, { error: 'wrong password' })
            }
            return reply(200, ctx.newDevice(b.deviceName, b.computer === true))
        }

        if (at('GET', /^\/api\/files\/dl$/)) {
            // A file dragged out of the page: a signed, short-lived link instead of a sign-in header (see share.js).
            if (!ctx.linkAllowed(url.searchParams)) return json(res, 403, { error: 'expired or not a valid link', code: 'bad-link' })
            return ctx.handleFiles(req, res, url, 'read', { phone: true, attachment: true })
        }

        const device = ctx.deviceFor(req.headers.authorization?.replace(/^Bearer /, ''))
        if (!device) return json(res, 401, { error: 'unauthorized' })

        // ---- Devices, computers, files ----

        if (at('GET', /^\/api\/computers$/)) {
            // linked: this computer can send Claude chats there (see Send to computer).
            return json(res, 200, ctx.moveTargets())
        }
        if (at('POST', /^\/api\/import$/)) {
            // A Claude chat sent from another of the user's computers: only from one linked as a computer.
            if (!device.computer) return json(res, 403, { error: 'only a linked computer can send a Claude chat' })
            const r = await ctx.receive(req, device)
            return json(res, r.status, r.body)
        }
        if ((m = /^\/api\/files\/([a-z]+)$/.exec(url.pathname))) {
            // The Shared folders: a linked computer may do everything; a phone or browser only browse, read and upload a
            // new file (the page's 📁), never move, overwrite or delete.
            return ctx.handleFiles(req, res, url, m[1], { phone: !device.computer, device })
        }
        if (at('POST', /^\/api\/pairing$/)) {
            // A signed-in device lets another one pair (a phone adding an iPad): the same single-use code as Tabby's
            // QR button. Only from a device that already has a token, so there is always existing trust.
            const p = ctx.newPairing()
            notifications.notice(`${device.name} is adding a device`)
            return json(res, 200, { code: p.code, url: p.url, expires: p.expires, svg: ctx.qrSvg(p.url, { cellSize: 6, margin: 4, scalable: true }) })
        }
        if (at('GET', /^\/api\/devices$/)) {
            return json(res, 200, store.devices.map(({ hash, ...d }) => ({ ...d, color: ctx.colorOf(d), current: d.id === device.id })))
        }
        if ((m = at('DELETE', /^\/api\/devices\/([^/]+)$/))) {
            const gone = store.devices.find(d => d.id === m[1])
            if (!gone) return json(res, 404, { error: 'not found' })
            ctx.removeDevice(gone)
            return json(res, 200, {})
        }
        if (at('POST', /^\/api\/upload$/)) {
            // The device then pastes the path into the terminal (Claude Code attaches an image given its path).
            const name = path.basename(decodeURIComponent(req.headers['x-filename'] ?? 'file')).replace(/[^\w.\- ]+/g, '_').slice(-120) || 'file'
            const file = await ctx.saveUpload(req, name)
            return file ? json(res, 200, { path: file }) : json(res, 413, { error: 'too large or failed' })
        }
        if (at('GET', /^\/api\/clipboard$/)) {
            return json(res, 200, await ctx.readClipboard())
        }
        if (at('PUT', /^\/api\/clipboard$/)) {
            const b = await body()
            if (typeof b?.text !== 'string') return json(res, 400, { error: 'text needed' })
            ctx.writeClipboard(b.text)
            return json(res, 200, {})
        }
        if (at('GET', /^\/api\/profiles$/)) {
            return json(res, 200, (await profiles.getProfiles()).map(p => ({ id: p.id ?? null, name: p.name, type: p.type, icon: p.icon ?? null })))
        }

        // ---- Sessions and groups ----

        if (at('GET', /^\/api\/sessions$/)) {
            return json(res, 200, ctx.terminalTabs().map(ctx.session))
        }
        if ((m = at('GET', /^\/api\/sessions\/([^/]+)\/peek$/))) {
            // The last lines on the tab's screen (its focused pane), as plain text, without attaching.
            const tab = ctx.tabById(m[1])
            if (!tab) return json(res, 404, { error: 'not found' })
            const xterm = (tab.focusedTab ?? ctx.panesOf(tab)[0])?.frontend?.xterm
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
            const b = await body()
            if (!b) return json(res, 400, { error: 'bad body' })
            if (typeof ctx.groups()?.drop !== 'function') return json(res, 501, { error: 'needs tabby-groups with drop()' })
            const side = x => x?.session ? ctx.tabById(String(x.session)) ?? null : x?.group ? { group: String(x.group) } : null
            const ok = ctx.groups().drop(side(b.source), side(b.target), b.where)
            return ok ? json(res, 200, {}) : json(res, 409, { error: 'not allowed there' })
        }
        if ((m = at('PATCH', /^\/api\/groups\/([^/]+)$/)) || (m = at('POST', /^\/api\/groups\/([^/]+)\/ungroup$/))) {
            // The sidebar's group menu, applied by tabby-groups' own functions.
            const tg = ctx.groups()
            if (!tg) return json(res, 501, { error: 'needs tabby-groups' })
            const name = decodeURIComponent(m[1])
            if (!tg.list().some(g => g.name === name)) return json(res, 404, { error: 'no such group' })
            if (req.method === 'POST') {
                tg.ungroup(name)
                setTimeout(ctx.tick)
                return json(res, 200, {})
            }
            const b = await body()
            if (!b) return json(res, 400, { error: 'bad body' })
            let ok = true
            if ('color' in b) tg.setColor(name, b.color ?? null)
            if ('collapsed' in b) tg.setCollapsed(name, !!b.collapsed)
            if ('pinned' in b) ok = tg.setPinned(name, !!b.pinned) !== false && ok
            if ('parent' in b) ok = tg.setParent(name, b.parent ?? null) !== false && ok
            let now = name
            if (typeof b.name === 'string' && b.name.trim() && b.name !== name) {
                if (tg.rename(name, b.name.trim())) now = b.name.trim()
                else ok = false
            }
            setTimeout(ctx.tick)
            return json(res, ok ? 200 : 409, tg.list().find(g => g.name === now) ?? {})
        }
        if (at('GET', /^\/api\/groups$/)) {
            return json(res, 200, ctx.groups()?.list() ?? [])
        }
        if (at('GET', /^\/api\/icons$/)) {
            // Built-in icons, plus the user's own from tabby-groups' settings (kind "user:<name>", maybe an emoji).
            const own = ctx.groups()?.icons?.() ?? []
            return json(res, 200, { ...icons, ...Object.fromEntries(own.map(i => [i.kind, i])) })
        }
        if (at('POST', /^\/api\/sessions$/)) {
            const b = await body()
            if (!b) return json(res, 400, { error: 'bad body' })
            const tab = await ctx.openSession(b)
            return tab ? json(res, 200, ctx.session(tab)) : json(res, 400, { error: 'could not open' })
        }
        if ((m = at('POST', /^\/api\/sessions\/([^/]+)\/send$/))) {
            // Send to computer, asked from a device (the phone): this computer exports the tab's Claude chat and sends it.
            const tab = ctx.tabById(m[1])
            if (!tab) return json(res, 404, { error: 'not found' })
            const b = await body()
            if (typeof b?.computerId !== 'string') return json(res, 400, { error: 'computerId needed' })
            const r = await ctx.sendWithNotice(tab, b.computerId)
            return json(res, r.ok ? 200 : 409, r)
        }
        if ((m = at('PATCH', /^\/api\/sessions\/([^/]+)$/))) {
            const tab = ctx.tabById(m[1])
            if (!tab) return json(res, 404, { error: 'not found' })
            const b = await body()
            if (!b) return json(res, 400, { error: 'bad body' })
            ctx.changeSession(tab, b)
            return json(res, 200, ctx.session(tab))
        }
        if ((m = at('DELETE', /^\/api\/sessions\/([^/]+)$/))) {
            const tab = ctx.tabById(m[1])
            if (!tab) return json(res, 404, { error: 'not found' })
            await app.closeTab(tab, false)
            return app.tabs.includes(tab) ? json(res, 409, { error: 'tab is pinned' }) : json(res, 200, {})
        }
        json(res, 404, { error: 'not found' })
    }

    function handleRequest (req, res) {
        // A request that goes quiet for a minute is dropped (there is no overall limit, for big files): a computer that
        // vanished mid-upload leaves no part file behind, and a slow sender holds nothing for long.
        req.setTimeout(60000, () => req.destroy())
        handle(req, res).catch(e => {
            console.error('[tabby-remote]', e)
            json(res, 500, { error: 'internal' })
        })
    }

    return { handleRequest }
}
