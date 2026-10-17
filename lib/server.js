const http = require('http')
const os = require('os')
const ws = require('../ws')
const { lanAddresses } = require('./net')

// This computer's Tailscale MagicDNS name, <hostname>.<tailnet>.ts.net: the hostname's first label, lowercased (a Mac's
// hostname can end in .local).
const MAGIC_DNS = new RegExp(`^${os.hostname().split('.')[0].toLowerCase().replace(/[^a-z0-9-]/g, '-')}\\.[a-z0-9-]+\\.ts\\.net:`)

/** Whether nothing else listens on `port` here (another Tabby on this computer takes the same default). */
const portFree = port => new Promise(resolve => {
    const probe = http.createServer()
    probe.once('error', () => resolve(false))
    probe.once('listening', () => probe.close(() => resolve(true)))
    probe.listen(port, '127.0.0.1')
})

/**
 * The HTTP and WebSocket servers, one per LAN address. A new network (another Wi-Fi, a new IP, Tailscale coming up)
 * is picked up within 30 s.
 */
module.exports = ctx => {
    const { store, clients, eventClients } = ctx
    const servers = new Map() // address → server

    const hosts = () => new Set(['localhost', ...lanAddresses()].map(a => `${a}:${ctx.listeningPort}`))
    const knownHost = host => hosts().has(host) || (MAGIC_DNS.test(host.toLowerCase()) && host.endsWith(`:${ctx.listeningPort}`))
    // The Host check stops DNS rebinding. Origin, when sent, must be our own page; native apps send none.
    const trusted = req => knownHost(req.headers.host ?? '') && (!req.headers.origin || req.headers.origin === `http://${req.headers.host}`)

    function upgrade (req, socket) {
        const p = new URL(req.url, 'http://x').pathname
        const m = /^\/api\/sessions\/([^/]+)\/panes\/([^/]+)\/attach$/.exec(p)
        if ((!m && p !== '/api/events') || !trusted(req)) return socket.end('HTTP/1.1 403 Forbidden\r\n\r\n')
        const conn = ws.accept(req, socket)
        if (!conn) return
        // The first message must be { type: 'auth', token }, within 5 s.
        const timer = setTimeout(() => conn.close(4001), 5000)
        conn.onMessage(ctx.inZone(text => {
            clearTimeout(timer)
            conn.onMessage(() => {})
            let msg = null
            try {
                msg = JSON.parse(text)
            } catch { }
            const device = msg?.type === 'auth' && ctx.deviceFor(msg.token)
            if (!device) return conn.close(4001)
            if (!m) {
                const client = { conn, device }
                eventClients.add(client)
                conn.onClose(() => eventClients.delete(client))
                return ctx.tick()
            }
            const tab = ctx.tabById(m[1])
            const pane = tab && ctx.panesOf(tab).find(x => x.__trId === m[2])
            if (!pane) return conn.close(4004)
            ctx.attach(conn, device, tab, pane).catch(e => {
                console.error('[tabby-remote] attach', e)
                conn.close(1011)
            })
        }))
    }

    function listen (addr) {
        const s = http.createServer(ctx.inZone(ctx.handleRequest))
        s.on('upgrade', ctx.inZone(upgrade))
        s.on('error', e => {
            console.warn(`[tabby-remote] ${addr}:${ctx.listeningPort}`, e.message)
            // Tried again on the next network check.
            if (servers.get(addr) === s) servers.delete(addr)
        })
        s.listen(ctx.listeningPort, addr)
        servers.set(addr, s)
    }

    /** Listens on addresses that appeared, and lets go of ones that went away. */
    function rebind () {
        const now = new Set(lanAddresses())
        for (const [addr, s] of servers) {
            if (now.has(addr)) continue
            s.close()
            s.closeAllConnections?.()
            servers.delete(addr)
        }
        for (const addr of now) {
            if (!servers.has(addr)) listen(addr)
        }
    }

    async function startServers () {
        if (servers.size) return
        // Reloading in place: the old instance must have released the port first.
        await ctx.previous
        if (ctx.disposed) return
        // The set port, else the next free one of the 10 after it, kept as this Tabby's port so its links still work.
        let port = store.port
        while (!(await portFree(port)) && port < store.port + 10) port++
        if (servers.size) return
        if (port !== store.port) {
            console.warn(`[tabby-remote] port ${store.port} is taken; using ${port}`)
            store.port = port
            ctx.save()
        }
        ctx.listeningPort = port
        lanAddresses().forEach(listen)
    }

    /** Phone access off: nothing listens on the network and every device is disconnected; they stay paired. */
    function stopServers () {
        ctx.closeQr()
        ;[...clients, ...eventClients].forEach(c => c.conn.close(1001))
        servers.forEach(s => s.close())
        servers.clear()
    }

    const timer = setInterval(() => servers.size && rebind(), 30000)

    ctx.cleanup.push(() => {
        clearInterval(timer)
        const closed = [...servers.values()].map(s => new Promise(resolve => {
            s.close(resolve)
            s.closeAllConnections?.()
        }))
        servers.clear()
        return Promise.all(closed)
    })
    return { trusted, startServers, stopServers, rebind, listening: () => servers.size > 0 }
}
