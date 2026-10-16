// ---- Touch: scrolling, selecting, sliding the cursor and pinching on the terminal ----

/**
 * Touch scrolling with the phone's own feel: an invisible native scroll layer lies over the terminal, and whatever
 * distance it scrolls (drag or iOS's own fling) is passed on, as a mouse wheel would scroll:
 * - an app that reads the mouse (Claude Code, Codex, vim with mouse on) gets wheel events, so it scrolls its own view;
 * - a full-screen app without mouse (less) gets ↑/↓;
 * - otherwise the terminal's own history scrolls.
 * ↑/↓ on the key bar stay keys (command history). A tap on the layer focuses the terminal for typing.
 */
function touchScroll (box, t, fitSize) {
    if (!touch.matches) return
    const MIDDLE = 500000
    const layer = el('div', { className: 'scroller' }, el('div', { className: 'scroller-space' }))
    box.parentElement.append(layer)
    let last = MIDDLE
    requestAnimationFrame(() => { layer.scrollTop = last = MIDDLE })
    let rest = 0
    const lineHeight = () => box.querySelector('.xterm-rows > div')?.offsetHeight || 15
    // Apps scroll about 3 lines per wheel step, so a step costs 3 lines of finger travel: the text follows the finger.
    const stepPx = () => lineHeight() * (t.modes.mouseTrackingMode !== 'none' ? 3 : 1)
    const scrollPx = px => {
        rest += px
        const lines = Math.trunc(rest / stepPx())
        if (!lines) return
        rest -= lines * stepPx()
        if (t.modes.mouseTrackingMode !== 'none') {
            // xterm turns each wheel event into the report the app asked for (SGR or X10), mid-screen.
            const r = box.getBoundingClientRect()
            for (let i = 0; i < Math.abs(lines); i++) {
                t.element.dispatchEvent(new WheelEvent('wheel', {
                    deltaY: Math.sign(lines) * lineHeight(), deltaMode: 0, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, bubbles: true, cancelable: true,
                }))
            }
        } else if (t.buffer.active.type === 'alternate') {
            sendKey(keySeq(lines > 0 ? 'down' : 'up').repeat(Math.abs(lines)))
        } else {
            t.scrollLines(lines)
        }
    }
    let idle = 0
    layer.addEventListener('scroll', () => {
        const d = layer.scrollTop - last
        last = layer.scrollTop
        // A jump of several screens at once is the layer being reset (a refresh, a re-layout), not a finger:
        // passing it on would throw the terminal to one end of its history.
        if (Math.abs(d) < layer.clientHeight * 4) scrollPx(d)
        // Back to the middle once it rests, so there is always room both ways (500k px: no fling reaches an end).
        clearTimeout(idle)
        idle = setTimeout(() => { layer.scrollTop = last = MIDDLE }, 400)
    }, { passive: true })
    // Typing starts only from a tap on the cursor's line (plus a finger's margin around it), like tapping a text field.
    // A tap anywhere else puts the keyboard away.
    let taps = 0
    let lastTap = null
    let pendingBlur = 0
    // The Copy chip goes whenever the selection does (new output, a tap, scrolling) and whenever the list scrolls.
    t.onSelectionChange(() => { if (!t.hasSelection()) $('copy-chip').hidden = true })
    layer.addEventListener('scroll', () => { $('copy-chip').hidden = true }, { passive: true })
    // Double tap and hold, then drag: the selection grows from that word to the finger, word by word's end.
    let drag = null
    layer.addEventListener('touchstart', e => {
        drag = null
        const p = e.touches[0]
        if (e.touches.length !== 1 || !lastTap || e.timeStamp - lastTap.t > 350 || Math.hypot(p.clientX - lastTap.x, p.clientY - lastTap.y) > 24) return
        const screen = t.element.querySelector('.xterm-screen').getBoundingClientRect()
        const at = cellAt(t, screen, p)
        drag = { screen, anchor: rangeAt(t, at, 'word') ?? { start: at, end: at + 1 }, moved: false }
        // Not a cursor slide or a sidebar swipe.
        layer.dataset.selecting = '1'
        layer.dataset.sliding = '1'
    }, { passive: true })
    layer.addEventListener('touchmove', e => {
        if (!drag) return
        e.preventDefault()
        drag.moved = true
        const at = cellAt(t, drag.screen, e.touches[0])
        const word = rangeAt(t, at, 'word') ?? { start: at, end: at + 1 }
        selectRange(t, { start: Math.min(drag.anchor.start, word.start), end: Math.max(drag.anchor.end, word.end) })
        drag.y = e.touches[0].clientY
    }, { passive: false })
    layer.addEventListener('touchend', () => {
        delete layer.dataset.selecting
        if (drag) setTimeout(() => delete layer.dataset.sliding)
        if (!drag?.moved) return
        showChip(t, drag.screen, drag.y)
        // The release is not a tap: the click that follows must not count as another one.
        taps = 0
        lastTap = null
        const swallow = ev => ev.stopPropagation()
        layer.addEventListener('click', swallow, { capture: true, once: true })
        setTimeout(() => layer.removeEventListener('click', swallow, { capture: true }), 400)
        drag = null
    })
    // A tap leaves the keyboard as it was; only the click handler below decides to raise or drop it.
    layer.addEventListener('mousedown', e => e.preventDefault())
    layer.addEventListener('click', e => {
        const b = t.buffer.active
        const screen = t.element.querySelector('.xterm-screen').getBoundingClientRect()
        const cell = screen.height / t.rows
        const row = b.cursorY + b.baseY - b.viewportY
        // Double tap selects a word, triple tap the line, as with a mouse on a computer.
        const near = lastTap && e.timeStamp - lastTap.t < 350 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 24
        taps = near ? taps + 1 : 1
        lastTap = { x: e.clientX, y: e.clientY, t: e.timeStamp }
        if (taps >= 2) {
            // Part of a double or triple tap: the keyboard stays as it was.
            clearTimeout(pendingBlur)
            return selectAt(t, screen, e, taps >= 3 ? 'line' : 'word')
        }
        // A tap clears the selection; the next key types normally.
        if (t.hasSelection()) t.clearSelection()
        t.__sel = null
        const middle = screen.top + (row + 0.5) * cell
        const reach = Math.max(1.5 * cell, 28)
        // No cursor line on screen (scrolled up, or Tabby took the size back): any tap starts typing again.
        const shown = layer.getBoundingClientRect()
        const visible = row >= 0 && row < t.rows && middle >= shown.top && middle <= shown.bottom
        if (!visible) return typeHere(t)
        if (Math.abs(e.clientY - middle) > reach) {
            // Waits a moment: if a second tap follows, it is a double tap (select), and the keyboard stays.
            clearTimeout(pendingBlur)
            pendingBlur = setTimeout(() => {
                t.blur()
                document.activeElement?.blur?.()
            }, 320)
            return
        }
        typeHere(t)
        // Tap on the line being typed: move the cursor to that spot, as in a text field.
        const tapRow = Math.max(0, Math.min(t.rows - 1, Math.floor((e.clientY - screen.top) / cell)))
        const tapCol = Math.max(0, Math.min(t.cols - 1, Math.floor((e.clientX - screen.left) / (screen.width / t.cols))))
        moveCursorTo(t, tapRow, tapCol)
    })
    holdSlide(layer, t)
    scrollBar(box.parentElement, t)

    // Pinch on the terminal changes the text size, as terminal apps do; the terminal refits to the new size,
    // and the size is remembered on this device. (Page zoom is off, so the layout never jumps.)
    let pinch = null
    let queued = false
    const gap = e => Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY)
    layer.addEventListener('touchstart', e => {
        if (e.touches.length === 2) pinch = { gap: gap(e), size: t.options.fontSize }
    }, { passive: true })
    layer.addEventListener('touchmove', e => {
        if (!pinch || e.touches.length !== 2) return
        e.preventDefault()
        const size = Math.min(28, Math.max(8, Math.round(pinch.size * gap(e) / pinch.gap * 2) / 2))
        if (size === t.options.fontSize) return
        t.options.fontSize = size
        remember('fontSize', size)
        // One refit per frame, after xterm has measured the new font.
        if (queued) return
        queued = true
        requestAnimationFrame(() => {
            queued = false
            fitSize()
        })
    }, { passive: false })
    layer.addEventListener('touchend', e => {
        if (e.touches.length < 2) pinch = null
    })
}

/** The buffer cell under a point, as a position counted along the buffer (row * cols + col). */
function cellAt (t, screen, e) {
    const col = Math.max(0, Math.min(t.cols - 1, Math.floor((e.clientX - screen.left) / (screen.width / t.cols))))
    const row = t.buffer.active.viewportY + Math.max(0, Math.min(t.rows - 1, Math.floor((e.clientY - screen.top) / (screen.height / t.rows))))
    return row * t.cols + col
}

/**
 * The text a tap means, as { start, end } buffer positions: a word (paths and URLs whole), or the line's text
 * inside the field it sits in: between box borders (Claude Code's input, TUI panes), past a shell prompt, trimmed.
 * Counts one character per cell, so a line with wide characters (CJK, some emoji) is off by a few.
 */
function rangeAt (t, at, what) {
    const b = t.buffer.active
    const row = Math.floor(at / t.cols)
    if (what === 'word') {
        const text = b.getLine(row)?.translateToString(false) ?? ''
        const col = at % t.cols
        const sep = ch => !ch || /[\s"'`()[\]{}<>|;,│┃║]/.test(ch)
        if (sep(text[col])) return null
        let start = col
        let end = col
        while (start > 0 && !sep(text[start - 1])) start--
        while (end < text.length && !sep(text[end])) end++
        return { start: row * t.cols + start, end: row * t.cols + end }
    }
    // A line that wraps over several rows is one line.
    let top = row
    let bottom = row
    while (top > 0 && b.getLine(top)?.isWrapped) top--
    while (b.getLine(bottom + 1)?.isWrapped) bottom++
    let text = ''
    for (let y = top; y <= bottom; y++) text += (b.getLine(y)?.translateToString(false) ?? '').padEnd(t.cols).slice(0, t.cols)
    const tap = at - top * t.cols
    let start = 0
    let end = text.length
    for (let i = tap - 1; i >= 0; i--) if (/[│┃║]/.test(text[i])) { start = i + 1; break }
    for (let i = tap; i < text.length; i++) if (/[│┃║]/.test(text[i])) { end = i; break }
    let part = text.slice(start, end)
    start += part.length - part.trimStart().length
    part = part.trim()
    const prompt = part.match(/^(?:PS )?[A-Za-z]:\\[^>]*>\s*|^[❯›>$#%]\s+/)
    if (prompt && prompt[0].length < part.length) {
        start += prompt[0].length
        part = part.slice(prompt[0].length)
    }
    if (!part) return null
    return { start: top * t.cols + start, end: top * t.cols + start + part.length }
}

function selectRange (t, r) {
    t.select(r.start % t.cols, Math.floor(r.start / t.cols), r.end - r.start)
}

function showChip (t, screen, y) {
    if (!t.hasSelection()) return
    const chip = $('copy-chip')
    chip.hidden = false
    chip.style.top = `${Math.max(screen.top + 4, y - 64)}px`
}

/** Double tap: the word under the finger; triple tap: the line in its field. Then a Copy chip. */
function selectAt (t, screen, e, what) {
    const r = rangeAt(t, cellAt(t, screen, e), what)
    if (!r) return
    selectRange(t, r)
    showChip(t, screen, e.clientY)
}

/**
 * Hold and slide to move the cursor: hold a finger on the line being typed for a moment, then slide; each cell
 * the finger crosses becomes ← or →. (iPhone's own space-bar trackpad cannot drive a web terminal: it moves the
 * caret of a hidden, near-zero-size text box, which snaps to its start.)
 */
function holdSlide (layer, t) {
    let hold = null // { x, y, timer, sliding, sent, cellW }
    const onCursorLine = y => {
        const b = t.buffer.active
        const screen = t.element.querySelector('.xterm-screen').getBoundingClientRect()
        const cell = screen.height / t.rows
        const middle = screen.top + (b.cursorY + b.baseY - b.viewportY + 0.5) * cell
        return Math.abs(y - middle) <= Math.max(1.5 * cell, 28) ? screen.width / t.cols : 0
    }
    layer.addEventListener('touchstart', e => {
        clearTimeout(hold?.timer)
        hold = null
        if (e.touches.length !== 1 || layer.dataset.selecting) return
        const { clientX: x, clientY: y } = e.touches[0]
        const cellW = onCursorLine(y)
        if (!cellW) return
        hold = { x, y, cellW, sliding: false, sent: 0 }
        hold.timer = setTimeout(() => {
            if (!hold) return
            hold.sliding = true
            // Tells the sidebar swipe that this horizontal move is the cursor, not a swipe.
            layer.dataset.sliding = '1'
            navigator.vibrate?.(10)
        }, 300)
    }, { passive: true })
    layer.addEventListener('touchmove', e => {
        if (!hold) return
        const { clientX: x, clientY: y } = e.touches[0]
        if (!hold.sliding) {
            // Moved before the hold took: an ordinary scroll.
            if (Math.hypot(x - hold.x, y - hold.y) > 8) {
                clearTimeout(hold.timer)
                hold = null
            }
            return
        }
        e.preventDefault()
        // Not past the end of what is typed, so the slide never accepts a grey suggestion.
        hold.maxRight ??= typedAhead(t)
        const cells = Math.min(Math.round((x - hold.x) / hold.cellW), hold.maxRight)
        const step = cells - hold.sent
        if (step) sendKey(keySeq(step > 0 ? 'right' : 'left').repeat(Math.abs(step)))
        hold.sent = cells
    }, { passive: false })
    layer.addEventListener('touchend', () => {
        if (hold?.sliding) {
            // The release must not also place the cursor where the finger stopped (tap to place).
            const swallow = ev => ev.stopPropagation()
            layer.addEventListener('click', swallow, { capture: true, once: true })
            setTimeout(() => layer.removeEventListener('click', swallow, { capture: true }), 400)
        }
        clearTimeout(hold?.timer)
        hold = null
        setTimeout(() => delete layer.dataset.sliding)
    })
}

/**
 * Scroll bar for the terminal's history on touch screens: the thumb is sized to the share of history on screen and
 * can be dragged; a tap on the track pages up or down. Hidden without history, and in full-screen apps such as
 * Claude Code, which keep their own history the page cannot see.
 */
function scrollBar (host, t) {
    const thumb = el('div', { className: 'vbar-thumb' })
    const bar = el('div', { className: 'vbar', ariaHidden: 'true' }, thumb)
    host.append(bar)
    const update = () => {
        const b = t.buffer.active
        const show = b.type === 'normal' && b.baseY > 0
        bar.hidden = !show
        if (!show) return
        const track = bar.clientHeight
        const size = Math.max(32, track * t.rows / (b.baseY + t.rows))
        thumb.style.height = `${size}px`
        thumb.style.transform = `translateY(${(track - size) * b.viewportY / b.baseY}px)`
    }
    t.onScroll(update)
    t.onWriteParsed(update)
    t.onResize(update)
    t.buffer.onBufferChange(update)
    new ResizeObserver(update).observe(bar)

    let grab = null
    bar.addEventListener('pointerdown', e => {
        e.preventDefault()
        const r = thumb.getBoundingClientRect()
        if (e.clientY < r.top || e.clientY > r.bottom) return t.scrollPages(e.clientY < r.top ? -1 : 1)
        grab = { y: e.clientY, line: t.buffer.active.viewportY }
        bar.setPointerCapture(e.pointerId)
    })
    bar.addEventListener('pointermove', e => {
        if (!grab) return
        const free = bar.clientHeight - thumb.offsetHeight
        const b = t.buffer.active
        t.scrollToLine(Math.round(grab.line + (e.clientY - grab.y) / Math.max(free, 1) * b.baseY))
    })
    const drop = () => { grab = null }
    bar.addEventListener('pointerup', drop)
    bar.addEventListener('pointercancel', drop)
}
