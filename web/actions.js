// ---- Group and tab actions, applied in Tabby by tabby-groups (the same as its own menus) ----

const PALETTE = [['No color', null], ['Red', '#f2756a'], ['Green', '#8ef58a'], ['Yellow', '#fdffad'], ['Blue', '#86b7f7'], ['Magenta', '#f48cf6'], ['Lavender', '#d7cff9']]
let pendingFold = 0

// Groups go by id: two groups under different parents can share a name.
const groupApi = (id, body) => api(`/api/groups/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(body) })
const groupName = id => groups.find(g => g.id === id)?.name ?? ''
const tabApi = (id, body) => api(`/api/sessions/${id}`, { method: 'PATCH', body: JSON.stringify(body) })

/** Folds or opens a group. Opening also opens its parents (tabby-groups' rule); shown at once here. */
function foldGroup (id, fold, head) {
    head?.querySelector('.caret')?.classList.toggle('open', !fold)
    const ids = fold ? [id] : chainOf(id)
    if (foldMode === 'device') {
        for (const n of ids) ownFolds[n] = fold
        remember('folds', ownFolds)
        return setTimeout(renderTree, 150)
    }
    for (const n of ids) {
        const g = groups.find(x => x.id === n)
        if (g) g.collapsed = fold
    }
    setTimeout(renderTree, 150)
    groupApi(id, { collapsed: fold })
}

/** "Group N", the first free N from the group count up, as tabby-groups names new groups. */
function newGroupName () {
    let n = groups.length + 1
    while (groups.some(g => g.name === `Group ${n}`)) n++
    return `Group ${n}`
}

async function renameGroup (id) {
    const name = groupName(id)
    const value = await prompt2('Rename group', name)
    if (value == null || !value.trim() || value === name) return
    const r = await groupApi(id, { name: value.trim() })
    if (!r.ok) flash('Could not rename it')
}

async function renameTab (s) {
    const value = await prompt2('Rename tab', s.title)
    // Empty clears the custom title, so the shell's own title shows again.
    if (value != null && value !== s.title) tabApi(s.id, { title: value.trim() })
}

/** Groups in tree order with their depth, for the "Move into" and "Add to group" lists. */
function groupTree () {
    const out = []
    const walk = (parent, depth) => groups.filter(g => (g.parentId ?? null) === parent).forEach(g => {
        out.push({ g, depth })
        walk(g.id, depth + 1)
    })
    walk(null, 0)
    return out
}

function openMenuFor (target, x, y) {
    const rowEl = target.closest('.row')
    if (rowEl) tabMenu(rowEl.dataset.id, x, y)
    else groupMenu(target.closest('.grp').dataset.group, x, y)
}

/** tabby-groups' group menu: colour, rename, collapse, pin, move into, ungroup. */
function groupMenu (id, x, y) {
    const g = groups.find(v => v.id === id)
    if (!g) return
    const own = new Set(groupTree().filter(({ g: v }) => chainOf(v.id).includes(id)).map(({ g: v }) => v.id))
    const targets = groupTree().filter(({ g: v }) => !own.has(v.id))
    showMenu([
        { swatches: PALETTE, current: g.color ?? null, pick: color => groupApi(id, { color }) },
        { sep: true },
        { text: 'Rename', run: () => renameGroup(id) },
        { text: isShut(g) ? 'Expand' : 'Collapse', run: () => foldGroup(id, !isShut(g)) },
        { text: g.pinned ? 'Unpin group' : 'Pin group', run: () => groupApi(id, { pinned: !g.pinned }) },
        ...(g.parentId || targets.length ? [{ text: 'Move into…', keepOpen: true, run: () => showMenu([
            { label: `Move "${g.name}" into` },
            { text: 'Top level', checked: !g.parentId, run: () => groupApi(id, { parent: null }) },
            ...targets.map(({ g: v, depth }) => ({ text: v.name, depth: depth + 1, checked: g.parentId === v.id, run: () => groupApi(id, { parent: v.id }) })),
        ], x, y) }] : []),
        { sep: true },
        { text: g.parentId ? 'Ungroup (move up a level)' : 'Ungroup', run: () => api(`/api/groups/${encodeURIComponent(id)}/ungroup`, { method: 'POST' }) },
    ], x, y)
}

/** tabby-groups' tab menu (add to group, new group, new subgroup, remove), plus rename, pin and close. */
function tabMenu (id, x, y) {
    const s = sessions.find(v => v.id === id)
    if (!s) return
    const inner = s.groupIds?.at(-1)
    showMenu([
        // Peek: the tab's last lines above its actions, as an iPhone long-press shows a preview.
        { peek: id },
        { text: 'Rename', run: () => renameTab(s) },
        ...(hasGroups ? [{ text: s.pinned ? 'Unpin' : 'Pin', run: () => tabApi(id, { pinned: !s.pinned }) }] : []),
        ...(hasGroups ? [{ text: 'Add to group…', keepOpen: true, run: () => showMenu([
            { label: `Add "${s.title}" to` },
            ...groupTree().map(({ g, depth }) => ({ text: g.name, depth, checked: g.id === inner, run: () => g.id !== inner && tabApi(id, { group: g.id }) })),
            { sep: true },
            { text: 'New group', run: () => tabApi(id, { group: newGroupName() }) },
        ], x, y) }] : []),
        ...(inner ? [
            { text: `New subgroup of ${s.group.at(-1)}`, run: () => tabApi(id, { group: newGroupName(), parent: inner }) },
            { text: 'Remove from group', run: () => tabApi(id, { group: null }) },
        ] : []),
        ...(s.kind === 'claude' ? [{ text: 'Send to computer…', keepOpen: true, run: () => sendMenu(s, x, y) }] : []),
        { sep: true },
        { text: 'Close tab', danger: true, run: () => closeTab(id) },
    ], x, y)
}

/** Send to computer: the Claude chat in this tab moves to another of the user's computers (linked in Tabby's
 *  Settings), which opens it in a new tab. The computer running the tab does the sending. */
async function sendMenu (s, x, y) {
    const r = await api('/api/computers').catch(() => null)
    const others = r?.ok ? await r.json() : []
    const send = async c => {
        setStatus(`Sending to ${c.name}…`)
        const res = await api(`/api/sessions/${s.id}/send`, { method: 'POST', body: JSON.stringify({ computerId: c.computerId }) }).catch(() => null)
        const out = await res?.json().catch(() => null)
        setStatus(null)
        flash(res?.ok ? `Opened on ${c.name}` : out?.error ?? 'Not sent')
    }
    showMenu([
        { label: `Send "${s.title}" to` },
        ...others.map(c => c.linked ? { text: c.name, run: () => send(c) } : { label: `${c.name}: link it in Tabby's Settings first` }),
        ...others.length ? [] : [{ label: 'No other computers seen on this Wi-Fi.' }],
    ], x, y)
}

/** Closes a tab in Tabby. A pinned tab is refused; `onRefused` lets a swiped row spring back. */
async function closeTab (id, onRefused) {
    const r = await api(`/api/sessions/${id}`, { method: 'DELETE' })
    if (r.status === 409) {
        onRefused?.()
        setStatus('Pinned: unpin it in Tabby to close')
        setTimeout(() => setStatus(null), 2500)
    }
}

/** Opens a shell tab in Tabby (in `group`, or outside every group) and shows it here. */
async function newTab (group) {
    const r = await api('/api/sessions', { method: 'POST', body: JSON.stringify(group ? { group } : {}) })
    if (!r.ok) return setStatus('Could not open a tab')
    const s = await r.json()
    if (!sessions.some(x => x.id === s.id)) sessions.push(s)
    open(s.id)
}
$('new-tab').onclick = () => newTab(null)
