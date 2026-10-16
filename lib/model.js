const crypto = require('crypto')

/** Tabby's tabs and panes as the API shows them. */
module.exports = ctx => {
    const { app } = ctx

    const idOf = o => (o.__trId ??= crypto.randomBytes(6).toString('hex'))
    const panesOf = tab => (tab.getAllTabs?.() ?? [tab]).filter(p => p.sendInput)
    const tabById = id => app.tabs.find(t => t.__trId === id)
    // Settings and other non-terminal tabs are not sessions.
    const terminalTabs = () => app.tabs.filter(t => panesOf(t).length)

    function groupPath (tab) {
        const groups = ctx.groups()?.list() ?? []
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
            remote: [...new Set([...ctx.clients].filter(c => panes.includes(c.pane)).map(c => c.device.name))],
            viewers: ctx.viewersOf(tab),
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

    return { panesOf, sizeOf, session, tabById, terminalTabs }
}
