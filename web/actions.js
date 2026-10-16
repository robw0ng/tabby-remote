// ---- Group and tab actions, applied in Tabby by tabby-groups (the same as its own menus) ----

const PALETTE = [['No color', null], ['Red', '#f2756a'], ['Green', '#8ef58a'], ['Yellow', '#fdffad'], ['Blue', '#86b7f7'], ['Magenta', '#f48cf6'], ['Lavender', '#d7cff9']]
let pendingFold = 0

const groupApi = (name, body) => api(`/api/groups/${encodeURIComponent(name)}`, { method: 'PATCH', body: JSON.stringify(body) })
const tabApi = (id, body) => api(`/api/sessions/${id}`, { method: 'PATCH', body: JSON.stringify(body) })

/** Folds or opens a group. Opening also opens its parents (tabby-groups' rule); shown at once here. */
function foldGroup (name, fold, head) {
    head?.querySelector('.caret')?.classList.toggle('open', !fold)
    const names = fold ? [name] : [name, ...chainOf(name)]
    if (foldMode === 'device') {
        for (const n of names) ownFolds[n] = fold
        remember('folds', ownFolds)
        return setTimeout(renderTree, 150)
    }
    for (const n of names) {
        const g = groups.find(x => x.name === n)
        if (g) g.collapsed = fold
    }
    setTimeout(renderTree, 150)
    groupApi(name, { collapsed: fold })
}

/** "Group N", the first free N from the group count up, as tabby-groups names new groups. */
function newGroupName () {
    let n = groups.length + 1
    while (groups.some(g => g.name === `Group ${n}`)) n++
    return `Group ${n}`
}

async function renameGroup (name) {
    const value = await prompt2('Rename group', name)
    if (value == null || !value.trim() || value === name) return
    const r = await groupApi(name, { name: value.trim() })
    if (!r.ok) flash('That name is taken')
}

async function renameTab (s) {
    const value = await prompt2('Rename tab', s.title)
    // Empty clears the custom title, so the shell's own title shows again.
    if (value != null && value !== s.title) tabApi(s.id, { title: value.trim() })
}

/** Groups in tree order with their depth, for the "Move into" and "Add to group" lists. */
function groupTree () {
    const out = []
    const walk = (parent, depth) => groups.filter(g => (g.parent ?? null) === parent).forEach(g => {
        out.push({ g, depth })
        walk(g.name, depth + 1)
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
function groupMenu (name, x, y) {
    const g = groups.find(v => v.name === name)
    if (!g) return
    const own = new Set(groupTree().filter(({ g: v }) => chainOf(v.name).includes(name)).map(({ g: v }) => v.name))
    const targets = groupTree().filter(({ g: v }) => !own.has(v.name))
    showMenu([
        { swatches: PALETTE, current: g.color ?? null, pick: color => groupApi(name, { color }) },
        { sep: true },
        { text: 'Rename', run: () => renameGroup(name) },
        { text: isShut(g) ? 'Expand' : 'Collapse', run: () => foldGroup(name, !isShut(g)) },
        { text: g.pinned ? 'Unpin group' : 'Pin group', run: () => groupApi(name, { pinned: !g.pinned }) },
        ...(g.parent || targets.length ? [{ text: 'Move into…', keepOpen: true, run: () => showMenu([
            { label: `Move "${name}" into` },
            { text: 'Top level', checked: !g.parent, run: () => groupApi(name, { parent: null }) },
            ...targets.map(({ g: v, depth }) => ({ text: v.name, depth: depth + 1, checked: g.parent === v.name, run: () => groupApi(name, { parent: v.name }) })),
        ], x, y) }] : []),
        { sep: true },
        { text: g.parent ? 'Ungroup (move up a level)' : 'Ungroup', run: () => api(`/api/groups/${encodeURIComponent(name)}/ungroup`, { method: 'POST' }) },
    ], x, y)
}

/** tabby-groups' tab menu (add to group, new group, new subgroup, remove), plus rename, pin and close. */
function tabMenu (id, x, y) {
    const s = sessions.find(v => v.id === id)
    if (!s) return
    const inner = s.group.at(-1)
    showMenu([
        // Peek: the tab's last lines above its actions, as an iPhone long-press shows a preview.
        { peek: id },
        { text: 'Rename', run: () => renameTab(s) },
        ...(hasGroups ? [{ text: s.pinned ? 'Unpin' : 'Pin', run: () => tabApi(id, { pinned: !s.pinned }) }] : []),
        ...(hasGroups ? [{ text: 'Add to group…', keepOpen: true, run: () => showMenu([
            { label: `Add "${s.title}" to` },
            ...groupTree().map(({ g, depth }) => ({ text: g.name, depth, checked: g.name === inner, run: () => g.name !== inner && tabApi(id, { group: g.name }) })),
            { sep: true },
            { text: 'New group', run: () => tabApi(id, { group: newGroupName() }) },
        ], x, y) }] : []),
        ...(inner ? [
            { text: `New subgroup of ${inner}`, run: () => tabApi(id, { group: newGroupName(), parent: inner }) },
            { text: 'Remove from group', run: () => tabApi(id, { group: null }) },
        ] : []),
        { sep: true },
        { text: 'Close tab', danger: true, run: () => closeTab(id) },
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
