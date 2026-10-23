// ---- Terminal: the attached pane, the header above it, and switching between list and terminal ----

function setView (v) {
    $('app').dataset.view = v
    // The way back only when there is a terminal to go back to.
    $('hide-list').hidden = !current
    if (v === 'list') requestAnimationFrame(revealCurrent)
}

/** Scrolls the sidebar so the open tab's row sits in the middle. Only the list scrolls, never the page. */
function revealCurrent () {
    const tree = $('tree')
    const row = tree.querySelector('.row[aria-current="true"]')
    if (!row) return
    const r = row.getBoundingClientRect()
    const t = tree.getBoundingClientRect()
    tree.scrollTop += r.top - t.top - (t.height - r.height) / 2
}
$('show-list').onclick = () => setView('list')
$('hide-list').onclick = () => setView('term')

/**
 * On phones, swipe the sidebar open and shut: on the terminal away from the sidebar's side opens it (it slides in
 * from that side), the other way on the sidebar closes it. A quick, mostly sideways swipe only, so scrolling, the
 * cursor slide and swiping a tab row away (leftwards, inside the list) keep their own gestures.
 */
// One touch, one axis: after AXIS_PX of movement a touch is sideways or up-and-down until the finger lifts. Sideways
// (clearly more across than down) is the page's: the page stops scrolling. Up-and-down is the browser's: it scrolls
// and no swipe fires. The swipeable elements also have CSS touch-action: pan-y, so iOS leaves sideways moves alone.
const AXIS_PX = 10
const AXIS_RATIO = 1.2

/** Calls `onSwipe(dx, dy, ms)` when a touch on `el` ends that was decided sideways; keeps the page still meanwhile. */
function lockAxis (el, onSwipe) {
    let t = null
    el.addEventListener('touchstart', e => {
        t = e.touches.length === 1 ? { x: e.touches[0].clientX, y: e.touches[0].clientY, at: e.timeStamp, axis: null } : null
    }, { passive: true })
    el.addEventListener('touchmove', e => {
        if (!t || e.touches.length !== 1) return void (t = null)
        const dx = e.touches[0].clientX - t.x
        const dy = e.touches[0].clientY - t.y
        if (!t.axis && Math.hypot(dx, dy) >= AXIS_PX) t.axis = Math.abs(dx) >= Math.abs(dy) * AXIS_RATIO ? 'x' : 'y'
        if (t.axis === 'x' && e.cancelable) e.preventDefault()
    }, { passive: false })
    el.addEventListener('touchend', e => {
        const p = e.changedTouches[0]
        if (t?.axis === 'x') onSwipe(p.clientX - t.x, p.clientY - t.y, e.timeStamp - t.at)
        t = null
    }, { passive: true })
    el.addEventListener('touchcancel', () => { t = null }, { passive: true })
}

function sideSwipe (area, dir, act, anyWidth = false) {
    lockAxis(area, (dx, dy, ms) => {
        if (!(narrow.matches || anyWidth)) return
        // Not when the move was something else: a cursor slide, a drag, a row swipe.
        const sliding = area.querySelector('.scroller')?.dataset.sliding
        if (ms < 600 && !sliding && !drag && !swipe && dx * dir() > 60) act()
    })
}
// The sidebar comes in from its side, and goes back out that way. The other way on the terminal accepts the grey
// suggestion (on tablets too): right with the sidebar on the right, left with it on the left.
const fromSide = () => sideLeft() ? 1 : -1
sideSwipe($('term-box'), fromSide, () => setView('list'))
sideSwipe($('side'), () => -fromSide(), () => current && setView('term'))
sideSwipe($('term-box'), () => -fromSide(), () => acceptSuggestion(), true)

function renderHead () {
    const s = sessions.find(x => x.id === current?.sessionId)
    if (!s) return
    $('term-title').textContent = s.title
    $('term-icon').replaceChildren(iconFor(s.kind, 18))
    // Who else is on this terminal, and whose screen size it is using when that is not this device.
    const sizer = (s.viewers ?? []).find(v => v.sizer && v.id !== me?.id)
    $('present').replaceChildren(...[badges(s, false), sizer ? el('span', { className: 'sized', textContent: `Sized for ${sizer.name}` }) : null].filter(Boolean))
    $('panes').replaceChildren(...(s.panes.length > 1 ? s.panes.map((p, i) => el('button', {
        ariaPressed: String(p.id === current.paneId),
        title: p.cwd ?? '',
        onclick: () => open(s.id, p.id),
    }, iconFor(p.kind, 14), String(i + 1))) : []))
}

function open (sessionId, paneId) {
    const s = sessions.find(x => x.id === sessionId)
    if (!s) return
    // Whether the keyboard was up (typing in the terminal or the predictions box) before this tab switch.
    const wasTyping = !!term && (document.activeElement === term.textarea || document.activeElement?.id === 'predict')
    $('copy-chip').hidden = true
    if (!s.panes.some(p => p.id === paneId)) paneId = (s.panes.find(p => p.focused) ?? s.panes[0]).id
    // The tab already open: just close the sidebar and carry on.
    if (current?.sessionId === sessionId && current.paneId === paneId && socket?.readyState === WebSocket.OPEN) {
        setView('term')
        if (!touch.matches || wasTyping) typeHere(term)
        return
    }
    current = { sessionId, paneId }
    remember('last', { sessionId, paneId, title: s.title })
    setView('term')
    renderHead()
    renderTree()

    socket?.close()
    term?.dispose()
    const box = el('div', { style: 'height:100%' })
    $('term-box').replaceChildren(box)
    term = new Terminal({
        scrollback: 10000,
        fontSize: saved('fontSize') ?? (narrow.matches ? 12 : 13),
        fontFamily: 'Menlo, Consolas, "Cascadia Mono", monospace',
        theme: { background: '#000000', selectionBackground: '#264f78' },
        // Search's match highlights use xterm's decorations.
        allowProposedApi: true,
    })
    const fit = new FitAddon.FitAddon()
    term.loadAddon(fit)
    term.open(box)
    // Tabby's own terminal answers the shell's queries; a second answer from here would land as typed input.
    term.parser.registerCsiHandler({ final: 'n' }, () => true)
    term.parser.registerCsiHandler({ final: 'c' }, () => true)
    term.parser.registerCsiHandler({ prefix: '>', final: 'c' }, () => true)
    term.parser.registerCsiHandler({ prefix: '?', final: 'h' }, params => params.includes(1004))
    for (const code of [10, 11, 12]) term.parser.registerOscHandler(code, data => data === '?')

    const ws = socket = new WebSocket(`ws://${location.host}/api/sessions/${sessionId}/panes/${paneId}/attach`)
    ws.binaryType = 'arraybuffer'
    const send = m => ws.readyState === 1 && ws.send(JSON.stringify(m))
    const t = term
    // Whether the app reads the mouse in SGR form (Claude Code does): a tap is then sent to it as a click (touch.js).
    for (const final of ['h', 'l']) t.parser.registerCsiHandler({ prefix: '?', final }, params => { if (params.includes(1006)) t.__sgr = final === 'h'; return false })
    let exited = false
    ws.onopen = () => {
        send({ type: 'auth', token })
        send({ type: 'presence', state: document.hidden ? 'away' : 'here' })
    }
    ws.onmessage = e => {
        if (typeof e.data !== 'string') return t.write(new Uint8Array(e.data))
        const m = JSON.parse(e.data)
        if (m.type === 'snapshot' || m.type === 'theme') applyTheme(t, m.theme)
        if (m.type === 'snapshot') {
            setStatus(null)
            t.reset()
            t.__sgr = false
            t.resize(m.cols, m.rows)
            // Then take this screen's size: xterm rewraps the history, and the shell redraws for the new width.
            t.write(m.data, () => {
                fitSize()
                t.scrollToBottom()
            })
        } else if (m.type === 'size') {
            t.resize(m.cols, m.rows)
        } else if (m.type === 'exit') {
            exited = true
            setStatus('Tab closed')
        }
    }
    ws.onclose = e => {
        if (e.code === 4001) return signOut('Signed out')
        if (socket !== ws || exited) return
        setStatus('Reconnecting…')
        setTimeout(() => socket === ws && start(), 2000)
    }

    // The terminal always takes this screen's size, and follows rotation and the keyboard opening.
    // If you type in Tabby meanwhile, Tabby takes its size back until you type here again.
    let ready = false
    const fitSize = () => {
        ready = true
        let d = fit.proposeDimensions()
        // The fit addon keeps room for xterm's scrollbar, which touch screens never show (the page draws its own
        // thin one over the text): there, fill the whole width, so no gap of several characters is left on the right.
        const cell = t._core?._renderService?.dimensions?.css?.cell
        if (d && touch.matches && cell?.width) {
            d = { cols: Math.max(2, Math.floor(box.clientWidth / cell.width)), rows: Math.max(1, Math.floor(box.clientHeight / cell.height)) }
            // What is left (under one character) is split between both sides, so the text sits centred.
            t.element.style.transform = `translateX(${Math.max(0, (box.clientWidth - d.cols * cell.width) / 2)}px)`
        }
        if (d && (d.cols !== t.cols || d.rows !== t.rows)) {
            t.resize(d.cols, d.rows)
            send({ type: 'resize', cols: d.cols, rows: d.rows })
        }
    }
    // While Claude asks a question, keys reach it one at a time, a moment apart: a word arriving at once (a prediction,
    // autocorrect, dictation), or keys bunched together, would cancel the question ("User declined").
    let paced = Promise.resolve()
    const input = data => {
        if (!claudeAsking) return void (paced = paced.then(() => send({ type: 'input', data })))
        // Split all but an escape sequence (an arrow, a bracketed paste), which must arrive whole.
        const parts = data.length > 1 && data[0] !== '\x1b' ? [...data] : [data]
        for (const part of parts) paced = paced.then(() => send({ type: 'input', data: part })).then(() => new Promise(resolve => setTimeout(resolve, 40)))
    }
    // Typing over a selection on the line being typed replaces it (⌫ deletes it), as in a text field.
    trackSelection(t)
    t.onData(data => {
        const sel = takeSelection(t)
        if (sel) replaceSelection(t, applyMods(data), sel)
        else input(applyMods(data))
    })
    new ResizeObserver(() => ready && fitSize()).observe(box)
    sendKey = input
    appCursor = () => t.modes.applicationCursorKeysMode
    touchScroll(box, t, fitSize)
    if (touch.matches) keepBackspaceRepeating(t)
    keyboardClipboard(t)
    copyClaudeSelectionOnRelease(t)
    // Typing goes on in the new tab: always with a keyboard and mouse; on a touch screen only when the phone keyboard
    // was already up (it stays up; it is never popped up by a tab switch). Done here, inside the tap or key that
    // switched tabs, which is when iOS allows it.
    if (!touch.matches || wasTyping) typeHere(t)
    resetPredict()
    closeFind()
    watchChoices(t)
}

/** Tabby's terminal colours (its colour scheme), so a tab looks here as it does in Tabby. An older server sends none. */
function applyTheme (t, theme) {
    if (!theme) return
    // Selections in Claude's blue (#264f78, what Claude Code draws for its own selection), not Tabby's grey.
    t.options.theme = { ...theme, selectionBackground: '#264f78', selectionForeground: undefined }
    if (theme.background) document.documentElement.style.setProperty('--term-bg', theme.background)
}

// Away when the phone locks or the page goes to the background; back when it returns. Others see it on the badge.
document.addEventListener('visibilitychange', () => {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'presence', state: document.hidden ? 'away' : 'here' }))
})
