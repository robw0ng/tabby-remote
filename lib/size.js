/** The size rule: the last remote typist sets the terminal's size; typing in Tabby takes it back. */
module.exports = ctx => {
    const { clients } = ctx

    const hasClients = pane => [...clients].some(c => c.pane === pane)

    function broadcastSize (pane) {
        const s = ctx.sizeOf(pane)
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

    function returnSize (pane) {
        if (!pane.__trSize) return
        pane.__trSize = pane.__trSizer = pane.__trSizerClient = null
        if (pane.size) pane.session?.resize(pane.size.columns, pane.size.rows)
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

    return { hasClients, takeSize, returnSize, handOff, watchTabby }
}
