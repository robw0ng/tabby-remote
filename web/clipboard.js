// ---- Copy and paste on this device: the page is plain http on the LAN, where the clipboard API is missing ----

/** Copies text on this device. The page is plain http on the LAN, so where the clipboard API is blocked a
 *  hidden text box and the browser's copy command do it (inside the tap, as browsers require). */
function copyText (text) {
    if (navigator.clipboard?.writeText && window.isSecureContext) return navigator.clipboard.writeText(text).then(() => true, () => false)
    const was = document.activeElement
    const ta = el('textarea', { value: text, readOnly: true, style: 'position:fixed;top:0;left:0;opacity:0' })
    document.body.append(ta)
    ta.select()
    ta.setSelectionRange(0, text.length)
    let ok = false
    try {
        ok = document.execCommand('copy')
    } catch { }
    ta.remove()
    // Back to where typing was, so the keyboard stays up.
    was?.focus?.({ preventScroll: true })
    return Promise.resolve(ok)
}

/**
 * Keyboard copy and paste in a desktop browser (the page is plain http, where the clipboard API is missing): Ctrl+C
 * with a selection copies it instead of sending ^C (without one it is still ^C), and Ctrl+V lets the browser paste
 * into the terminal (bracketed, as xterm pastes) instead of sending ^V. On a Mac, Cmd+C copies the same way, Claude's
 * selection included; Cmd+V already pastes.
 */
function keyboardClipboard (t) {
    t.attachCustomKeyEventHandler(e => {
        if (e.type !== 'keydown' || e.altKey || e.ctrlKey === e.metaKey) return true
        const k = e.key.toLowerCase()
        if (e.metaKey && k !== 'c') return true
        const text = k === 'c' && selectedText(t)
        if (text) {
            copyText(text).then(ok => flash(ok ? 'Copied' : 'Could not copy'))
            t.clearSelection()
            e.preventDefault()
            return false
        }
        // Not handled by xterm and not prevented: the browser pastes into xterm's text box.
        if (k === 'v') return false
        return true
    })
}

$('chip-copy').onclick = () => {
    const text = term?.getSelection() ?? ''
    term?.clearSelection()
    $('copy-chip').hidden = true
    copyText(text).then(ok => flash(ok ? 'Copied' : 'Could not copy'))
}

// ---- Copy and Paste: a sheet with a plain text box ----
// The page is plain http on the LAN, where browsers block clipboard access from script; inside a text box the
// phone's own select, copy and paste menus always work.

/** The terminal's screen as text, wrapped lines joined back into one, trailing blank lines dropped. */
function screenText (t) {
    const b = t.buffer.active
    const lines = []
    for (let y = b.viewportY; y < b.viewportY + t.rows; y++) {
        const line = b.getLine(y)
        if (!line) continue
        const text = line.translateToString(true)
        if (line.isWrapped && lines.length) lines[lines.length - 1] += text
        else lines.push(text)
    }
    while (lines.length && !lines.at(-1).trim()) lines.pop()
    return lines.join('\n')
}

function openSheet (kind) {
    if (!term) return
    const box = $('sheet-text')
    $('sheet').dataset.kind = kind
    $('sheet-title').textContent = kind === 'copy' ? 'Copy' : 'Paste'
    $('sheet-go').textContent = kind === 'copy' ? 'Copy all' : 'Send'
    box.readOnly = kind === 'copy'
    box.value = kind === 'copy' ? screenText(term) : ''
    box.placeholder = kind === 'paste' ? 'Paste or type here' : ''
    $('sheet').hidden = false
    // Across devices: pull the PC's clipboard, attach a file from the phone, or put the copied text on the PC.
    const extra = kind === 'paste'
        ? [el('button', { textContent: 'From PC', onclick: pasteFromPc }), el('button', { textContent: 'Attach…', onclick: () => $('file-pick').click() })]
        : [el('button', { textContent: 'Copy to PC', onclick: copyToPc })]
    $('sheet-extra').replaceChildren(...extra)
    if (kind === 'paste') {
        box.focus()
        // Where the browser allows it (https, localhost), fill it straight from the clipboard.
        navigator.clipboard?.readText?.().then(text => { if (!box.value) box.value = text }).catch(() => {})
    } else {
        box.scrollTop = box.scrollHeight
    }
}

/** Pastes file paths at the cursor, quoted when they hold spaces; Claude Code attaches an image given its path. */
function pastePaths (paths) {
    term?.paste(paths.map(p => /\s/.test(p) ? `"${p}"` : p).join(' ') + ' ')
}

async function pasteFromPc () {
    const r = await api('/api/clipboard')
    if (!r.ok) return flash('Needs a Tabby restart')
    const { text, path } = await r.json()
    // An image on the PC's clipboard arrives as a saved file: paste its path straight away.
    if (path) {
        closeSheet()
        return pastePaths([path])
    }
    $('sheet-text').value = text ?? ''
}

async function copyToPc () {
    const r = await api('/api/clipboard', { method: 'PUT', body: JSON.stringify({ text: $('sheet-text').value }) })
    if (!r.ok) return flash('Needs a Tabby restart')
    $('sheet-extra').querySelector('button').textContent = 'On the PC ✓'
    setTimeout(closeSheet, 700)
}

function closeSheet () {
    $('sheet').hidden = true
    $('sheet-text').blur()
    // Closing a rename box without saving answers "no change".
    promptDone?.(null)
}

$('sheet-close').onclick = closeSheet
$('sheet').addEventListener('click', e => e.target === $('sheet') && closeSheet())
$('sheet-text').addEventListener('keydown', e => {
    if (e.key === 'Enter' && $('sheet').dataset.kind === 'prompt') {
        e.preventDefault()
        $('sheet-go').click()
    }
})
$('sheet-go').onclick = async () => {
    const box = $('sheet-text')
    if ($('sheet').dataset.kind === 'prompt') return promptDone?.(box.value)
    if ($('sheet').dataset.kind === 'paste') {
        // xterm's paste: bracketed when the app asks for it, and newlines sent as Enter.
        if (box.value) term?.paste(box.value)
        return closeSheet()
    }
    const ok = await copyText(box.value)
    $('sheet-go').textContent = ok ? 'Copied' : 'Could not copy'
    setTimeout(closeSheet, 600)
}

// ---- Claude's own selection ----
// Claude Code reads the mouse, so a drag in a Claude tab makes Claude's selection, not xterm's; Claude then copies it
// on the computer running it, out of this page's reach. It draws that selection in a fixed blue, so the page reads
// the highlighted cells off the screen and copies them on this device instead.

const CLAUDE_SELECTION_BG = 0x264f78

/** The text Claude shows selected on screen, row by row, or ''. */
function claudeSelection (t) {
    const b = t.buffer.active
    const rows = []
    for (let y = 0; y < t.rows; y++) {
        const line = b.getLine(b.viewportY + y)
        if (!line) continue
        let text = ''
        let any = false
        for (let x = 0; x < t.cols; x++) {
            const c = line.getCell(x)
            if (c?.isBgRGB() && c.getBgColor() === CLAUDE_SELECTION_BG) {
                any = true
                text += c.getChars() || ' '
            }
        }
        if (any) rows.push(text.trimEnd())
    }
    return rows.join('\n')
}

/** What a copy should take: xterm's selection, else Claude's. */
const selectedText = t => (t.hasSelection() && t.getSelection()) || claudeSelection(t)

/**
 * With a mouse: releasing a drag in a Claude tab copies Claude's new selection here, as Claude does on its own
 * computer. Claude draws it a moment after the release, so the page waits for it (still within the click, which
 * browsers require for copying).
 */
function copyClaudeSelectionOnRelease (t) {
    if (touch.matches) return
    let down = null
    t.element.addEventListener('mousedown', e => { down = { x: e.clientX, y: e.clientY } })
    t.element.addEventListener('mouseup', e => {
        const dragged = down && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4
        down = null
        if (!dragged || !t.modes.mouseTrackingMode || t.modes.mouseTrackingMode === 'none') return
        const started = Date.now()
        const look = () => {
            const text = claudeSelection(t)
            if (text) return copyText(text).then(ok => ok && flash('Copied'))
            if (Date.now() - started < 1000) setTimeout(look, 60)
        }
        setTimeout(look, 60)
    })
}

// The browser's own Copy (right-click › Copy, Ctrl+Insert, the Edit menu): the terminal's selection, as text.
document.addEventListener('copy', e => {
    if (!term || String(window.getSelection?.() ?? '')) return
    const text = selectedText(term)
    if (!text) return
    e.clipboardData.setData('text/plain', text)
    e.preventDefault()
})
