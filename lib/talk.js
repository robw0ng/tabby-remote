/**
 * Talk: a Claude chat here messages a Claude tab on another of the user's computers (POST /api/say there), and that
 * chat answers the same way. Only between linked computers, only into Claude tabs (tabby-groups' sayToClaude), and
 * each message arrives stamped with the computer it came from, which the sender cannot change.
 */
const MAX_MESSAGE = 8000
const MAX_TITLE = 200

module.exports = ctx => {
    const { store, notifications } = ctx

    // ---- Sending (window.__tabbyRemote.talk, used by tabby-groups' tab-say.mjs --computer) ----

    /** A request to the linked computer called `name`, with this computer's token for it: { ok, ...answer } or { ok: false, why }. */
    async function call (name, method, p, body) {
        const [id, l] = Object.entries(store.links ?? {}).find(([, l]) => l.name.toLowerCase() === String(name).toLowerCase()) ?? []
        if (!l) return { ok: false, why: `${name} is not a linked computer (link it in Settings > Phone access)` }
        const base = ctx.addressOf(id)
        if (!base) return { ok: false, why: `${l.name} is not reachable` }
        // Not what answers there (an old version, or something else announcing that computer): its token is not sent.
        if (!await ctx.verifiedPeer(id, base)) return { ok: false, why: `${l.name} did not answer as itself: update tabby-remote there, or link it again` }
        const r = await ctx.linkRequest(new URL(p, base), { method, headers: { Authorization: `Bearer ${l.token}`, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) })
        if (r.status === 200) return { ok: true, ...r.json }
        if (r.status === 401) return { ok: false, why: `${l.name} no longer knows this computer: link it again` }
        if (r.status === 404) return { ok: false, why: `${l.name} has a tabby-remote too old to talk: update it there` }
        return { ok: false, why: r.json?.error ?? (r.status ? `${l.name} answered ${r.status}` : `${l.name} is not reachable`) }
    }

    const talkApi = {
        /** Types `message` into the Claude tab titled `tab` on `computer`; `from` is the sending tab's title, for the reply. */
        say: (computer, tab, message, from) => call(computer, 'POST', 'api/say', { tab, message, from }),
        /** The Claude tabs on `computer`: { ok, chats: [title] }. */
        chats: computer => call(computer, 'GET', 'api/chats'),
    }

    // ---- Receiving (from a linked computer only, checked in routes.js) ----

    function claudeChats () {
        const titles = ctx.app.tabs.flatMap(t => ctx.panesOf(t)).filter(p => p.__tgInfo?.kind === 'claude').map(p => p.customTitle || p.title)
        return { status: 200, body: { chats: titles } }
    }

    async function receiveSay (body, device) {
        const { tab, message, from } = body ?? {}
        if (typeof tab !== 'string' || !tab.trim() || tab.length > MAX_TITLE) return { status: 400, body: { error: 'tab: a Claude tab title' } }
        if (typeof message !== 'string' || !message.trim() || message.length > MAX_MESSAGE) return { status: 400, body: { error: `message: 1 to ${MAX_MESSAGE} characters` } }
        const g = ctx.groups()
        // sayToClaude, not say: an older tabby-groups would type into any tab, a shell included.
        if (!g?.sayToClaude) return { status: 501, body: { error: 'talking needs tabby-groups 0.1.5 or later on this computer' } }
        // The computer's name comes from its link here, never from the message: the sender cannot pose as another.
        const sender = device.name.replace(/ \(computer\)$/, '')
        const back = typeof from === 'string' && from.trim() ? from.trim().slice(0, MAX_TITLE).replace(/"/g, "'") : null
        const text = `[from ${sender}${back ? ` · "${back}"` : ''}] ${message}` +
            (back ? ` (reply: node tab-say.mjs "${back}" "<reply>" --computer ${sender}, from the tabby-groups plugin)` : '')
        const r = await g.sayToClaude(tab, text)
        if (!r.ok) return { status: 409, body: { error: r.why } }
        notifications.notice(`${sender} messaged "${r.tab}"`)
        return { status: 200, body: { tab: r.tab } }
    }

    return { talkApi, claudeChats, receiveSay }
}
