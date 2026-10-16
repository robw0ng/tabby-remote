// ---- Drag and drop in the sidebar, with tabby-groups' rules ----
// Touch: hold a row or group header ~0.4 s, then drag. Mouse: just drag. Where it lands follows tabby-groups:
// a tab's middle groups with it ("onto"), its top or bottom quarter goes before or after it (halves when a group is
// dragged, or the tab is alone in its group); a group header's halves are "above" and "first in the group"; the gap
// under a group's last row is "last in it" / "below it". Tabby applies the drop (POST /api/move), and the list
// updates from Tabby's events.

const dropLine = el('div', { className: 'drop-line' })
const ghost = el('div', { className: 'drag-ghost' })
let drag = null // { source: { session } | { group }, label, el }

const parentOf = name => groups.find(g => g.name === name)?.parent ?? null
/** The group and all its ancestors. */
const chainOf = name => {
    const out = []
    for (let n = name; n && out.length <= groups.length; n = parentOf(n)) out.push(n)
    return out
}

function intentAt (x, y) {
    const src = drag.source
    for (const hit of document.elementsFromPoint(x, y)) {
        if (!hit.closest('#tree')) continue
        const row = hit.closest('.row')
        if (row) {
            const s = sessions.find(v => v.id === row.dataset.id)
            if (!s || s.id === src.session) return null
            // A dragged group cannot land among its own rows.
            if (src.group && s.group.includes(src.group)) return null
            const inner = s.group.at(-1)
            const lone = inner && !sessions.some(v => v.id !== s.id && v.id !== src.session && v.group.at(-1) === inner)
            const r = row.getBoundingClientRect()
            const f = (y - r.top) / r.height
            const where = src.group || lone ? (f < 0.5 ? 'before' : 'after') : f < 0.25 ? 'before' : f > 0.75 ? 'after' : 'onto'
            return { el: row, target: { session: s.id }, where }
        }
        const bar = hit.closest('.grp-bar')
        const box = hit.closest('.grp')
        if (!box) continue
        const name = box.dataset.group
        if (src.group && chainOf(name).includes(src.group)) return null
        if (bar) {
            const r = bar.getBoundingClientRect()
            return { el: bar, target: { group: name }, where: (y - r.top) / r.height < 0.5 ? 'above' : 'first' }
        }
        // The gap under the group's last row.
        const r = box.getBoundingClientRect()
        return { el: box, target: { group: name }, where: y > r.bottom - 3 ? 'below' : 'last' }
    }
    return null
}

function showMark (i) {
    document.querySelectorAll('.drop-onto').forEach(e => e.classList.remove('drop-onto'))
    if (!i || i.where === 'onto') {
        dropLine.remove()
        i?.el.classList.add('drop-onto')
        return
    }
    const r = i.el.getBoundingClientRect()
    // "last" sits above the group's bottom gap, at its last row; "below" under the whole group.
    const top = i.where === 'last' ? r.bottom - 6 : ['after', 'first', 'below'].includes(i.where) ? r.bottom : r.top
    Object.assign(dropLine.style, { left: `${r.left + 6}px`, width: `${r.width - 12}px`, top: `${top - 1}px` })
    document.body.append(dropLine)
}

let edgeScroll = 0
function dragMove (x, y) {
    Object.assign(ghost.style, { left: `${x + 12}px`, top: `${y + 8}px` })
    if (drag.cancelled) return
    drag.intent = intentAt(x, y)
    showMark(drag.intent)
    // Near the top or bottom of the list, it scrolls.
    const t = $('tree').getBoundingClientRect()
    const speed = y < t.top + 40 ? -8 : y > t.bottom - 40 ? 8 : 0
    cancelAnimationFrame(edgeScroll)
    if (speed) {
        const step = () => {
            $('tree').scrollTop += speed
            drag && (edgeScroll = requestAnimationFrame(step))
        }
        edgeScroll = requestAnimationFrame(step)
    }
}

async function dragEnd (apply) {
    cancelAnimationFrame(edgeScroll)
    const d = drag
    drag = null
    ghost.remove()
    showMark(null)
    d.el.classList.remove('dragging')
    // The click that ends a drag must not also open the tab or fold the group.
    const swallow = e => e.stopPropagation()
    document.addEventListener('click', swallow, true)
    setTimeout(() => document.removeEventListener('click', swallow, true))
    if (!apply || !d.intent) return
    const r = await api('/api/move', { method: 'POST', body: JSON.stringify({ source: d.source, target: d.intent.target, where: d.intent.where }) })
    if (r.ok) return
    setStatus(r.status === 501 ? 'Drag needs the latest tabby-groups' : "Can't drop there")
    setTimeout(() => setStatus(null), 2000)
}

function dragStart (target, x, y) {
    const row = target.closest('.row')
    const bar = target.closest('.grp-bar')
    const source = row ? { session: row.dataset.id } : { group: bar.parentElement.dataset.group }
    drag = { source, el: row ?? bar, intent: null }
    drag.el.classList.add('dragging')
    ghost.textContent = row ? row.querySelector('.title').textContent : source.group
    document.body.append(ghost)
    dragMove(x, y)
}

// Swipe a row left to close its tab, as in iPhone lists: the red Close grows behind it; let go past a third of
// the row and the tab closes, otherwise it springs back.
let swipe = null // { row, x, dx }
function swipeMove (dx) {
    swipe.dx = Math.min(0, dx)
    swipe.row.style.setProperty('--swipe', `${swipe.dx}px`)
}
function swipeEnd () {
    const { row, dx } = swipe
    swipe = null
    $('tree').style.overflowY = ''
    const back = () => {
        row.classList.add('settling')
        row.style.setProperty('--swipe', '0px')
        setTimeout(() => row.classList.remove('swiping', 'settling'), 200)
    }
    if (-dx < row.offsetWidth / 3) return back()
    row.classList.add('settling')
    row.style.setProperty('--swipe', `${-row.offsetWidth}px`)
    closeTab(row.dataset.id, back)
}

{
    const tree = $('tree')
    let press = null // { timer, x, y, target, mouse }
    tree.addEventListener('pointerdown', e => {
        const target = e.target.closest('.row, .grp-head')
        if (!target || e.target.closest('.grp-add') || e.button !== 0) return
        press = { x: e.clientX, y: e.clientY, target, mouse: e.pointerType === 'mouse' }
        // Touch, the iPhone way: hold, then let go for the menu, or move to drag. A quick swipe still scrolls.
        if (!press.mouse) {
            press.timer = setTimeout(() => {
                if (!press) return
                press.held = true
                press.target.classList.add('held')
                navigator.vibrate?.(10)
            }, 400)
        }
    })
    tree.addEventListener('pointermove', e => {
        if (drag) return dragMove(e.clientX, e.clientY)
        if (swipe) return swipeMove(e.clientX - swipe.x)
        if (!press) return
        const dx = e.clientX - press.x
        const dy = e.clientY - press.y
        const moved = Math.hypot(dx, dy)
        // Without tabby-groups there is nowhere to drop, so a hold and move does not start a drag.
        if (press.held && moved > 8) {
            press.target.classList.remove('held')
            if (hasGroups) dragStart(press.target, e.clientX, e.clientY)
            press = null
        } else if (press.mouse && moved > 5) {
            if (hasGroups) dragStart(press.target, e.clientX, e.clientY)
            else press = null
        }
        else if (!press.mouse && moved >= AXIS_PX) {
            clearTimeout(press.timer)
            // Mostly sideways on a tab row: a swipe; anything else: the list scrolls.
            const row = press.target.closest('.row')
            // The same axis rule as lockAxis, so a row swipe and a sidebar swipe decide alike.
            if (row && dx < 0 && Math.abs(dx) >= Math.abs(dy) * AXIS_RATIO) {
                swipe = { row, x: press.x, dx: 0 }
                row.classList.add('swiping')
                // Once it is a swipe, the list holds still until the finger lifts.
                tree.style.overflowY = 'hidden'
                swipeMove(dx)
            }
            press = null
        }
    })
    const up = e => {
        clearTimeout(press?.timer)
        const held = press?.held && e.type === 'pointerup' ? press.target : null
        held?.classList.remove('held')
        press = null
        if (held) {
            // Held and let go without moving: the menu, and no click on the row or header.
            const swallow = ev => ev.stopPropagation()
            document.addEventListener('click', swallow, true)
            setTimeout(() => document.removeEventListener('click', swallow, true))
            openMenuFor(held)
        }
        if (drag) dragEnd(e.type === 'pointerup')
        if (swipe) {
            // A swipe ends without a click on the row.
            const swallow = ev => ev.stopPropagation()
            document.addEventListener('click', swallow, true)
            setTimeout(() => document.removeEventListener('click', swallow, true))
            swipeEnd()
        }
    }
    tree.addEventListener('pointerup', up)
    tree.addEventListener('pointercancel', up)
    // While held, dragging or swiping by touch, the finger moves the tab, not the list.
    tree.addEventListener('touchmove', e => (drag || swipe || press?.held) && e.preventDefault(), { passive: false })
    // With a mouse: right-click for the menu.
    tree.addEventListener('contextmenu', e => {
        const target = e.target.closest('.row, .grp-head')
        if (!target) return
        e.preventDefault()
        openMenuFor(target, e.clientX, e.clientY)
    })
    // With a mouse, as in tabby-groups: double-click a tab to rename it; double-click free space for a new tab in
    // the group under the pointer (or outside every group). Double-clicking a group name renames it (see groupEl).
    tree.addEventListener('dblclick', e => {
        if (e.target.closest('.grp-add, .grp-head')) return
        const rowEl = e.target.closest('.row')
        if (rowEl) return renameTab(sessions.find(s => s.id === rowEl.dataset.id))
        newTab(e.target.closest('.grp')?.dataset.group ?? null)
    })
    // Escape clears the drop target, as in tabby-groups: letting go then does nothing.
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape' && drag) {
            drag.cancelled = true
            drag.intent = null
            showMark(null)
        }
    })
}
