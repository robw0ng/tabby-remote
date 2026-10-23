/**
 * /api/events: the session list diffed every half second and on Tabby's own signals. Polling catches the cwd and
 * icon changes tabby-groups makes without an event. Subscribe per field if CPU matters.
 */
module.exports = ctx => {
    const { app, eventClients } = ctx
    let lastSessions = null
    let lastGroups = null

    function tick () {
        if (!eventClients.size) {
            lastSessions = lastGroups = null
            return
        }
        const now = new Map(ctx.terminalTabs().map(t => {
            const s = ctx.session(t)
            return [s.id, { s, json: JSON.stringify(s) }]
        }))
        const g = ctx.groups()?.list() ?? []
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
    const subs = [app.tabsChanged$, app.activeTabChange$].map(o => o.subscribe(() => setTimeout(tick)))
    // tabby-groups says when a Claude tab turns busy or waiting.
    const onAgent = () => setTimeout(tick)
    window.addEventListener('tabby-groups:agent', onAgent)

    // The side of Tabby's tab bar (Settings > Appearance > Tabs location), so the page puts its sidebar there too:
    // left, or right for a bar on the top, bottom or right.
    const tabsSide = () => ctx.config.store?.appearance?.tabsLocation === 'left' ? 'left' : 'right'
    let side = tabsSide()
    subs.push(ctx.config.changed$.subscribe(() => {
        if (tabsSide() === side) return
        side = tabsSide()
        eventClients.forEach(c => c.conn.send(JSON.stringify({ type: 'side', side })))
    }))

    ctx.cleanup.push(() => {
        clearInterval(timer)
        subs.forEach(s => s.unsubscribe())
        window.removeEventListener('tabby-groups:agent', onAgent)
    })
    return { tick, tabsSide }
}
