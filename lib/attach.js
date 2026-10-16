const terminalTheme = require('./theme')

/** A device attached to one pane: Tabby's output streams to it, its keys and size come back. */
module.exports = ctx => {
    const { app, clients, config } = ctx

    async function attach (conn, device, tab, pane) {
        const client = { conn, device, pane, size: null }
        const subs = []
        let inputQueue = Promise.resolve()
        // Registered first, so a client that leaves at any point below is cleaned up.
        conn.onClose(() => {
            subs.forEach(s => s.unsubscribe())
            const watched = clients.delete(client)
            if (!ctx.hasClients(pane)) {
                if (watched) pane.__trUnwatch?.()
                // Also when it left before the snapshot: a resize it sent early still has to be undone.
                ctx.returnSize(pane)
            } else {
                ctx.handOff(pane, client)
            }
            ctx.updatePresence()
        })
        // Input and resize work from the moment of auth; they do not wait for the snapshot.
        conn.onMessage(ctx.inZone(text => {
            let m
            try {
                m = JSON.parse(text)
            } catch {
                return
            }
            if (m.type === 'input' && typeof m.data === 'string') {
                const wasTyping = ctx.isTyping(client)
                client.lastInput = Date.now()
                if (!wasTyping) setTimeout(ctx.updatePresence)
                ctx.takeSize(client)
                // PSReadLine drops keys that land while it redraws for a resize, so input waits
                // out a fixed 200 ms after one. A shell that redraws slower would still lose keys.
                const wait = 200 - (Date.now() - (pane.__trResizedAt ?? 0))
                inputQueue = inputQueue
                    .then(() => wait > 0 && new Promise(resolve => setTimeout(resolve, wait)))
                    .then(() => pane.sendInput(m.data))
            } else if (m.type === 'resize' && Number.isInteger(m.cols) && Number.isInteger(m.rows)) {
                client.size = { cols: Math.min(Math.max(m.cols, 2), 1000), rows: Math.min(Math.max(m.rows, 2), 1000) }
                ctx.takeSize(client)
            } else if (m.type === 'presence') {
                // The page went to the background (phone locked, app swiped away, tab switched): Tabby gets its size
                // back. Back on screen, the device takes it again unless another device holds it now.
                client.away = m.state === 'away'
                if (client.away) ctx.handOff(pane, client)
                else if (!pane.__trSize) ctx.takeSize(client)
                ctx.updatePresence()
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
        if (!ctx.hasClients(pane)) ctx.watchTabby(pane)
        clients.add(client)
        ctx.updatePresence()

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
        conn.send(JSON.stringify({ type: 'snapshot', cols, rows, data: snapshot, theme: terminalTheme(config) }))
        if (pane.__trSize) conn.send(JSON.stringify({ type: 'size', ...pane.__trSize }))
        buffered.forEach(d => conn.send(Buffer.from(d)))
        live = true
        // Opening a tab on a device counts as seeing it: tabby-groups clears its "needs you".
        ctx.groups()?.markSeen?.(tab)
    }

    // A new colour scheme in Tabby's settings reaches the attached pages at once.
    let themeJson = 'null'
    const themeSub = config.changed$.subscribe(() => {
        const json = JSON.stringify(terminalTheme(config))
        if (json === themeJson) return
        themeJson = json
        for (const c of clients) c.conn.send(`{"type":"theme","theme":${json}}`)
    })

    ctx.cleanup.push(() => themeSub.unsubscribe())
    return { attach }
}
