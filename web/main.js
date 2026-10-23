// ---- Data: the session list, kept current by the events socket; then the boot ----

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
    const info = await (await fetch('/api/info')).json().catch(() => ({}))
    hasGroups = info.groups !== false
    // Which computer this is (an older server sends no name).
    computer = info.name ?? ''
    if (info.side) applySide(info.side)
    $('term-host').textContent = computer
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
        else if (m.type === 'side') applySide(m.side)
        queueRender()
        if (current && m.session?.id === current.sessionId) renderHead()
    }
    ws.onclose = e => {
        if (e.code === 4001) return signOut('Signed out')
        if (events === ws) setTimeout(() => token && start(), 2000)
    }
}

;(async () => {
    if (await tryPair()) return
    if (token) start()
    else signOut()
})()
