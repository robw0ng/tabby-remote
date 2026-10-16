const http = require('http')
const ws = require('../ws')
const { lanAddresses } = require('./net')

/** Whether nothing else listens on `port` here (another Tabby on this computer takes the same default). */
const portFree = port => new Promise(resolve => {
    const probe = http.createServer()
    probe.once('error', () => resolve(false))
    probe.once('listening', () => probe.close(() => resolve(true)))
    probe.listen(port, '127.0.0.1')
})

/**
 * The HTTP and WebSocket servers, one per LAN address present when they start: restart Tabby (or turn Phone access
 * off and on) after joining a new network.
 */
module.exports = ctx => {
    const { store, clients, eventClients } = ctx
    let servers = []

    const hosts = () => new Set(['localhost', ...lanAddresses()].map(a => `${a}:${ctx.listeningPort}`))
    // The Host check stops DNS rebinding. Origin, when sent, must be our own page; native apps send none.
    const trusted = req => hosts().has(req.headers.host) && (!req.headers.origin || req.headers.origin === `http://${req.headers.host}`)

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

    async function startServers () {
        if (servers.length) return
        // Reloading in place: the old instance must have released the port first.
        await ctx.previous
        if (ctx.disposed) return
        // The set port, else the next free one of the 10 after it, kept as this Tabby's port so its links still work.
        let port = store.port
        while (!(await portFree(port)) && port < store.port + 10) port++
        if (servers.length) return
        if (port !== store.port) {
            console.warn(`[tabby-remote] port ${store.port} is taken; using ${port}`)
            store.port = port
            ctx.save()
        }
        ctx.listeningPort = port
        servers = lanAddresses().map(addr => {
            const s = http.createServer(ctx.inZone(ctx.handleRequest))
            s.on('upgrade', ctx.inZone(upgrade))
            s.on('error', e => console.warn(`[tabby-remote] ${addr}:${port}`, e.message))
            s.listen(port, addr)
            return s
        })
    }

    /** Phone access off: nothing listens on the network and every device is disconnected; they stay paired. */
    function stopServers () {
        ctx.closeQr()
        ;[...clients, ...eventClients].forEach(c => c.conn.close(1001))
        servers.forEach(s => s.close())
        servers = []
    }

    ctx.cleanup.push(() => {
        const closed = servers.map(s => new Promise(resolve => {
            s.close(resolve)
            s.closeAllConnections?.()
        }))
        servers = []
        return Promise.all(closed)
    })
    return { trusted, startServers, stopServers, listening: () => servers.length > 0 }
}
