// ---- The line being typed: what is typed, accepting a suggestion, moving the cursor, editing a selection ----

/**
 * How many cells of real typing follow the cursor: up to the last character, stopping at dim text, which is a
 * suggestion (Claude Code's suggested prompt, PowerShell's prediction) that → would accept. Follows wrapped rows.
 */
function typedAhead (t) {
    const b = t.buffer.active
    let y = b.baseY + b.cursorY
    let x = b.cursorX
    let count = 0
    let last = 0
    for (let guard = 0; guard < 4000; guard++) {
        if (x >= t.cols) {
            if (!b.getLine(y + 1)?.isWrapped) break
            y++
            x = 0
        }
        const c = b.getLine(y)?.getCell(x)
        if (!c || c.isDim()) break
        count++
        if (c.getChars().trim()) last = count
        x++
    }
    return last
}

/**
 * Accepts the grey suggestion after what is typed (PowerShell's prediction, Claude's suggested prompt): → to the end
 * of the typed text, then one more →, which accepts it in both. Without a suggestion it does nothing.
 */
function acceptSuggestion () {
    const t = term
    if (!t || !touch.matches) return
    const b = t.buffer.active
    const typed = typedAhead(t)
    // The grey text right after it (it may start with a space) must hold something.
    let found = false
    for (let at = b.cursorX + typed; at < b.cursorX + typed + t.cols && !found; at++) {
        const c = b.getLine(b.baseY + b.cursorY + Math.floor(at / t.cols))?.getCell(at % t.cols)
        if (!c?.isDim()) break
        found = !!c.getChars().trim()
    }
    if (found) sendKey(keySeq('right').repeat(typed + 1))
}

const isClaudeTab = () => sessions.find(x => x.id === current?.sessionId)?.kind === 'claude'
/** Whether a screen row is part of what is being typed: not a blank row or a box border (Claude's ─── lines). */
const typingRow = (t, viewRow) => /[^\s─━═]/.test(t.buffer.active.getLine(t.buffer.active.viewportY + viewRow)?.translateToString(true) ?? '')

/**
 * Moves the cursor to a cell of the line being typed. In a shell a long line wraps exactly at the edge, so the
 * distance in cells is the distance in characters, sent as ← or →. Claude wraps a prompt by whole words and indents
 * the next row, so there a different row is reached with ↑/↓ first (they move within Claude's prompt, keeping the
 * column), then ←/→ along that row. Never past the end of what is typed: → there would accept a grey suggestion.
 */
async function moveCursorTo (t, viewRow, col) {
    const b = t.buffer.active
    const cursorRow = () => b.cursorY + b.baseY - b.viewportY
    if (viewRow !== cursorRow() && isClaudeTab()) {
        // ↑ on the prompt's first row would recall history: only rows of the prompt itself.
        if (!typingRow(t, viewRow)) return
        sendKey(keySeq(viewRow < cursorRow() ? 'up' : 'down').repeat(Math.abs(viewRow - cursorRow())))
        await new Promise(resolve => {
            const moved = t.onCursorMove(() => { if (cursorRow() === viewRow) done() })
            const timer = setTimeout(done, 400)
            function done () {
                moved.dispose()
                clearTimeout(timer)
                resolve()
            }
        })
        if (cursorRow() !== viewRow) return
    }
    const cells = Math.min((viewRow - cursorRow()) * t.cols + (col - b.cursorX), typedAhead(t))
    if (cells) sendKey(keySeq(cells > 0 ? 'right' : 'left').repeat(Math.min(Math.abs(cells), 400)))
}

/** The selection when it lies on the line being typed (the cursor's row, or the rows next to it that are part of
 *  it), else null. A selection in the output above is just for copying. */
function inputSelection (t) {
    const p = t.hasSelection() && t.getSelectionPosition()
    if (!p) return null
    const b = t.buffer.active
    const cursor = b.baseY + b.cursorY
    if (p.start.y < cursor - 2 || p.end.y > cursor + 2) return null
    for (let y = p.start.y; y <= p.end.y; y++) if (!typingRow(t, y - b.viewportY)) return null
    return p
}

/**
 * xterm clears its selection as soon as a key is typed, just before the key reaches the page, so the last selection
 * on the line being typed is remembered here and still counts for a key within 150 ms of it being cleared.
 */
function trackSelection (t) {
    t.onSelectionChange(() => {
        if (t.hasSelection()) {
            const p = inputSelection(t)
            t.__sel = p && { p, text: t.getSelection(), cleared: 0 }
        } else if (t.__sel && !t.__sel.cleared) {
            t.__sel.cleared = performance.now()
        }
    })
}
/** The selection a key just typed should replace, if any (and forget it). */
function takeSelection (t) {
    const sel = t.__sel
    t.__sel = null
    return sel && (!sel.cleared || performance.now() - sel.cleared < 150) ? sel : null
}

let editing = Promise.resolve()
/** Replaces the selection with `data` (⌫ alone deletes the whole selection): the cursor goes to its end, then one ⌫
 *  per selected character, then the new text. A wrapped row's end counts as one character, the space it wrapped at. */
function replaceSelection (t, data, sel) {
    t.clearSelection()
    resetPredict()
    editing = editing.then(async () => {
        await moveCursorTo(t, sel.p.end.y - t.buffer.active.viewportY, sel.p.end.x)
        await new Promise(resolve => setTimeout(resolve, 60))
        sendKey('\x7f'.repeat(sel.text.length) + (data === '\x7f' || data === '\b' ? '' : data))
    })
}
