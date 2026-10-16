// Picked to stay apart from the group palette.
const DEVICE_COLORS = ['#4fc3f7', '#ffb74d', '#ba68c8', '#4db6ac', '#f06292', '#aed581', '#ffd54f', '#90a4ae']
const TYPING_MS = 4000
const RANK = { typing: 2, watching: 1, away: 0 }

/** Which device is on which tab, and what it is doing: for the API, and for Tabby's own sidebar. */
module.exports = ctx => {
    const { app, store, clients } = ctx

    const colorOf = device => device.color ?? DEVICE_COLORS[Math.max(0, store.devices.indexOf(device)) % DEVICE_COLORS.length]
    /** The first colour no other device has, so devices stay easy to tell apart. */
    function freeColor () {
        const used = new Set(store.devices.map(colorOf))
        return DEVICE_COLORS.find(c => !used.has(c)) ?? DEVICE_COLORS[store.devices.length % DEVICE_COLORS.length]
    }
    const isTyping = client => Date.now() - (client.lastInput ?? 0) < TYPING_MS

    /**
     * One entry per device attached to any pane of the tab: { id, name, color, state, sizer }.
     * state: 'typing' (sent keys in the last 4 s) > 'watching' > 'away' (its page is in the background).
     * sizer: the terminal is at this device's size.
     */
    function viewersOf (tab) {
        const panes = ctx.panesOf(tab)
        const byDevice = new Map()
        for (const c of clients) {
            if (!panes.includes(c.pane)) continue
            const state = isTyping(c) ? 'typing' : c.away ? 'away' : 'watching'
            const prev = byDevice.get(c.device.id)
            const sizer = panes.some(p => p.__trSizer === c.device.id)
            if (!prev || RANK[state] > RANK[prev.state]) byDevice.set(c.device.id, { id: c.device.id, name: c.device.name, color: colorOf(c.device), state, sizer: sizer || !!prev?.sizer })
        }
        return [...byDevice.values()]
    }

    // For Tabby's own sidebar (tabby-groups draws the badges): each tab carries `__trPresence`, and a
    // 'tabby-remote:presence' event on window says it changed. Checked every second while anyone is attached.
    const presenceJson = new Map()
    function updatePresence () {
        ctx.stayAwake()
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
    const timer = setInterval(() => (clients.size || presenceJson.size) && updatePresence(), 1000)

    ctx.cleanup.push(() => {
        clearInterval(timer)
        app.tabs.forEach(t => { delete t.__trPresence })
        window.dispatchEvent(new CustomEvent('tabby-remote:presence'))
    })
    return { colorOf, freeColor, isTyping, viewersOf, updatePresence }
}
