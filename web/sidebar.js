// ---- Sidebar: tabs inside their groups, as tabby-groups draws them ----

/** `color`/`depth` are the panel the row sits in, so the active row can take tabby-groups' stronger tint. */
function row (s, color, depth, shade = 0) {
    const r = el('button', {
        // Claude's state, as tabby-groups draws it: a spinning ring on the icon while busy; a dot and a bold title
        // when it finished while nobody was looking ("needs you"); an amber ? or ! while it asks (a question, or
        // a permission prompt), in place of the dot.
        className: 'row' + (s.cwd ? ' two-line' : '') + (s.agent?.needsYou ? ' needs-you' : '') + (s.agent?.state === 'busy' ? ' busy' : '') + (s.agent?.asking ? ' asking' : ''),
        ariaCurrent: String(current?.sessionId === s.id),
        title: [s.title, s.cwd].filter(Boolean).join('\n'),
        onclick: () => open(s.id),
    },
    el('span', { className: 'num', textContent: s.index }),
    s.pinned ? el('span', { className: 'pin', ariaLabel: 'pinned' }, pinIcon()) : null,
    // No icon for an app tabby-groups has none for.
    icons[s.kind] ? agentMarks(el('span', { className: 'icon' }, iconFor(s.kind, 14)), s.agent) : null,
    el('span', { className: 'text' }, el('span', { className: 'title', textContent: s.title }), s.cwd ? el('span', { className: 'cwd', textContent: s.cwd }) : null),
    badges(s),
    // Mouse only (touch swipes the row away): Tabby's ✕ on hover.
    el('span', { className: 'close', role: 'button', ariaLabel: `Close ${s.title}`, title: 'Close tab', textContent: '✕', onclick: e => { e.stopPropagation(); closeTab(s.id) } }))
    if (color) r.style.setProperty('--active-bg', darken(`color-mix(in srgb, ${color} ${tintPct(depth) + ACTIVE_TINT_ADD}%, var(--bg))`, shade))
    r.dataset.id = s.id
    return r
}

// ---- Presence: a badge per other device on each tab it has open (the same badges as in Tabby's sidebar) ----

const STATE_RANK = { typing: 0, watching: 1, away: 2 }
const STATE_WORD = { typing: 'typing', watching: 'watching', away: 'away' }

/** One device badge: its initial in its colour; typing pulses, away is dimmed. */
function badge (v) {
    return el('span', {
        className: `badge ${v.state}`,
        textContent: (v.name || '?')[0].toUpperCase(),
        title: `${v.name} · ${STATE_WORD[v.state]}${v.sizer ? ' · sets the size' : ''}`,
        style: `--c:${v.color}`,
    })
}

/** The other devices on this tab, at most 3 then "+N", and a monitor for the tab active on the PC. */
function badges (s, withPc = true) {
    const others = (s.viewers ?? []).filter(v => v.id !== me?.id).sort((a, b) => STATE_RANK[a.state] - STATE_RANK[b.state])
    const pc = withPc && s.active ? el('span', { className: 'badge pc', title: 'Active in Tabby on the PC' }, monitorIcon()) : null
    if (!others.length && !pc) return null
    return el('span', { className: 'badges' }, pc, ...others.slice(0, 3).map(badge), others.length > 3 ? el('span', { className: 'badge-more', textContent: `+${others.length - 3}` }) : null)
}

/**
 * Search as tabby-groups does: case-insensitive, split into words, and every word must match the title, a group on
 * its path, the folder, the app (key or label), or, for a number with or without '#', the tab's number.
 */
function matches (s, query) {
    const hay = [s.title, ...s.group, s.cwd, s.kind, icons[s.kind]?.label].filter(Boolean).join('\n').toLowerCase()
    return query.split(/\s+/).every(w => hay.includes(w) || (/^#?\d+$/.test(w) && String(s.index) === w.replace('#', '')))
}

/** Groups nest by `parent`; tabs sit in their innermost group. Everything keeps Tabby's tab order. */
function tree (keep = () => true) {
    const nodes = new Map(groups.map(g => [g.name, { group: g, kids: [], first: Infinity, count: 0 }]))
    const top = []
    for (const s of [...sessions].filter(keep).sort((a, b) => a.index - b.index)) {
        const g = nodes.get(s.group.at(-1))
        ;(g ? g.kids : top).push({ tab: s, first: s.index })
    }
    for (const n of nodes.values()) {
        const p = nodes.get(n.group.parent)
        ;(p ? p.kids : top).push(n)
    }
    const settle = n => {
        if (n.tab) return
        n.kids.forEach(settle)
        n.kids = n.kids.filter(k => k.tab || k.count > 0).sort((a, b) => a.first - b.first)
        n.first = Math.min(Infinity, ...n.kids.map(k => k.first))
        n.count = n.kids.reduce((c, k) => c + (k.tab ? 1 : k.count), 0)
    }
    const root = { kids: top }
    settle(root)
    return root.kids
}

function groupEl (n, depth, hiddenAbove = false) {
    const g = n.group
    const shut = isShut(g)
    const color = g.color ?? NO_COLOR
    const box = el('div', { className: 'grp' + (depth === 0 ? ' top' : '') })
    box.dataset.group = g.name
    const shade = shadeOf(g)
    box.style.background = darken(`color-mix(in srgb, ${color} ${tintPct(depth)}%, var(--bg))`, shade)
    // For marks that ring themselves in the panel's colour (the asking mark).
    box.style.setProperty('--panel-bg', box.style.background)
    box.append(el('div', { className: 'grp-bar' },
        el('button', {
            className: 'grp-head',
            ariaExpanded: String(!shut),
            // As in tabby-groups: a click folds after 220 ms, so a double-click (rename) can cancel it.
            onclick: e => {
                if (e.detail > 1) return
                const head = e.currentTarget
                clearTimeout(pendingFold)
                pendingFold = setTimeout(() => foldGroup(g.name, !(shut || hiddenAbove), head), 220)
            },
            ondblclick: e => {
                clearTimeout(pendingFold)
                if (e.target.closest('.name')) renameGroup(g.name)
            },
        },
        // A subgroup inside a collapsed parent is drawn collapsed too, as in tabby-groups.
        el('span', { className: 'caret' + (shut || hiddenAbove ? '' : ' open') }, chevron()),
        el('span', { className: 'name', textContent: g.name }),
        el('span', { className: 'count' }, `${n.count} tab${n.count === 1 ? '' : 's'}`, rollup(g))),
        g.pinned ? el('span', { className: 'grp-pin', ariaLabel: 'pinned group', title: 'Pinned group' }, pinIcon()) : null,
        el('button', { className: 'icon-btn grp-add', textContent: '+', ariaLabel: `New tab in ${g.name}`, title: `New tab in ${g.name}`, onclick: () => newTab(g.name) })))
    box.querySelector('.grp-head').title = g.name
    // Collapsed (itself or a parent), it shows only the open tab and the subgroups on the way to it,
    // as tabby-groups shows the active tab. While searching, collapse is ignored.
    const hide = !searching() && (shut || hiddenAbove)
    const holds = k => k.tab ? k.tab.id === current?.sessionId : k.kids.some(holds)
    const kids = hide ? n.kids.filter(holds) : n.kids
    kids.forEach(k => box.append(k.tab ? row(k.tab, color, depth, shade) : groupEl(k, depth + 1, hide)))
    box.classList.toggle('empty', !kids.length)
    return box
}

const searching = () => !!$('search').value.trim()

/**
 * tabby-groups' roll-up for the whole subtree: " · 1 needs you · 2 busy", so a folded group still says something
 * finished. Tapping it opens the first tab in the group that needs you.
 */
function rollup (g) {
    const parts = [g.needsYou ? `${g.needsYou} need${g.needsYou === 1 ? 's' : ''} you` : null, g.busy ? `${g.busy} busy` : null].filter(Boolean)
    if (!parts.length && !g.asking && !g.running && !g.compacting) return null
    return el('span', {
        className: 'rollup',
        // As in tabby-groups: "· N asking" in amber, then "· N running" in green, then the blue parts.
        onclick: e => {
            const first = sessions.filter(s => (s.agent?.asking || s.agent?.needsYou) && s.group.includes(g.name))
                .sort((a, b) => !!b.agent?.asking - !!a.agent?.asking || a.index - b.index)[0]
            if (!first) return
            e.stopPropagation()
            clearTimeout(pendingFold)
            open(first.id)
        },
    }, g.asking ? el('span', { className: 'asking', textContent: ` · ${g.asking} asking` }) : null,
    g.running ? el('span', { className: 'running', textContent: ` · ${g.running} running` }) : null,
    g.compacting ? el('span', { className: 'compacting', textContent: ` · ${g.compacting} compacting` }) : null,
    parts.length ? ' · ' + parts.join(' · ') : null)
}

// ---- "Needs you": a notice when a Claude finishes on a tab this page is not showing ----

let toastTimer = 0
function toast (text, onTap) {
    const t = $('toast')
    t.textContent = text
    t.onclick = () => { t.hidden = true; onTap?.() }
    t.hidden = false
    navigator.vibrate?.(30)
    clearTimeout(toastTimer)
    toastTimer = setTimeout(() => { t.hidden = true }, 6000)
}

/** Called with each changed session: a notice when it newly needs you. */
function watchAgents (before, after) {
    if (after?.agent?.asking && !before?.agent?.asking && after.id !== current?.sessionId) {
        toast(`${after.title} is asking`, () => open(after.id))
    } else if (after?.agent?.needsYou && !before?.agent?.needsYou && after.id !== current?.sessionId) {
        toast(`${after.title} needs you`, () => open(after.id))
    }
}

/** How many tabs need you: a badge on ☰ (the title is not shown full screen from the Home Screen) and in the title. */
function showNeedsYou () {
    // Asking counts too, and turns the badge amber.
    const n = sessions.filter(s => s.agent?.needsYou || s.agent?.asking).length
    document.title = `${n ? `(${n}) ` : ''}Tabby${computer ? ` · ${computer}` : ' Remote'}`
    $('list-badge').classList.toggle('asking', sessions.some(s => s.agent?.asking))
    $('list-badge').hidden = !n
    $('list-badge').textContent = n > 9 ? '9+' : n
    $('show-list').ariaLabel = n ? `Show tabs, ${n} need${n === 1 ? 's' : ''} you` : 'Show tabs'
}

/** One redraw per frame for a burst of events; none mid-drag, menu or swipe (as tabby-groups pauses), one after. */
let renderQueued = false
function queueRender () {
    if (renderQueued) return
    renderQueued = true
    requestAnimationFrame(function again () {
        if (drag || swipe || !$('menu').hidden) return requestAnimationFrame(again)
        renderQueued = false
        renderTree()
    })
}

/** The sidebar. While searching, only matching tabs show, still inside their groups (as in tabby-groups). */
function renderTree () {
    const q = $('search').value.trim().toLowerCase()
    const nodes = tree(q ? s => matches(s, q) : undefined)
    $('tree').replaceChildren(...nodes.map(n => n.tab ? row(n.tab) : groupEl(n, 0)))
    showNeedsYou()
}
$('search').oninput = renderTree
// Enter opens the first match; Escape clears the search.
$('search').addEventListener('keydown', e => {
    if (e.key === 'Enter') $('tree').querySelector('.row')?.click()
    if (e.key === 'Escape') {
        $('search').value = ''
        $('search').blur()
        renderTree()
    }
})
