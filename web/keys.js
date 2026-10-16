// ---- Key bar for touch screens: Termux's two-row layout, with a sticky Shift the iPhone keyboard lacks ----

const mods = { ctrl: false, alt: false, shift: false }
let sendKey = () => {}
let appCursor = () => false
const setMod = (name, on) => {
    mods[name] = on
    document.querySelector(`[data-key="${name}"]`).ariaPressed = String(on)
}
const clearMods = () => ['ctrl', 'alt', 'shift'].forEach(m => setMod(m, false))
/** Sticky Shift, Ctrl and Alt apply to the next key, from the bar or the phone keyboard. */
function applyMods (data) {
    if (mods.shift && data.length === 1) data = data.toUpperCase()
    if (mods.ctrl && data.length === 1 && /[a-z@[\\\]^_ ]/i.test(data)) {
        data = data === ' ' ? '\x00' : String.fromCharCode(data.toUpperCase().charCodeAt(0) & 31)
    }
    if (mods.alt) data = '\x1b' + data
    clearMods()
    return data
}
/** The bytes for a key-bar key, with the held modifiers in xterm's encoding (CSI 1;m X, m = 1 + Shift + 2·Alt + 4·Ctrl). */
function keySeq (k) {
    const m = 1 + (mods.shift ? 1 : 0) + (mods.alt ? 2 : 0) + (mods.ctrl ? 4 : 0)
    const letter = { up: 'A', down: 'B', right: 'C', left: 'D', home: 'H', end: 'F' }[k]
    // Arrows follow the app's cursor mode (vim, less and full-screen apps switch it).
    if (letter) return m > 1 ? `\x1b[1;${m}${letter}` : k === 'home' || k === 'end' ? KEYS[k] : (appCursor() ? '\x1bO' : '\x1b[') + letter
    const page = { pgup: 5, pgdn: 6 }[k]
    if (page) return m > 1 ? `\x1b[${page};${m}~` : KEYS[k]
    if (k === 'tab') return (mods.alt ? '\x1b' : '') + (mods.shift ? '\x1b[Z' : '\t')
    return (mods.alt ? '\x1b' : '') + KEYS[k]
}

// No page zoom: it would fight the keyboard-fitted layout. Safari ignores user-scalable=no, but not these.
for (const type of ['gesturestart', 'gesturechange']) document.addEventListener(type, e => e.preventDefault())
$('keys').hidden = !touch.matches
$('keys').addEventListener('pointerdown', e => e.preventDefault()) // keep the phone keyboard open
$('keys').addEventListener('click', e => {
    const k = e.target.closest('button')?.dataset.key
    if (!k) return
    if (k === 'ctrl' || k === 'alt' || k === 'shift') return setMod(k, !mods[k])
    if (k === 'copy' || k === 'paste') return openSheet(k)
    // The line changed in a way the predictions box cannot follow (a cursor move, Tab completion, history).
    resetPredict()
    sendKey(keySeq(k))
    clearMods()
})

/**
 * iPhone repeats a held ⌫ only while the text box has text to delete, and the terminal's hidden text box is always
 * empty (each key goes straight to the terminal), so ⌫ deleted once per press. A few invisible characters keep it
 * repeating; each ⌫ still sends the terminal one delete, and the filler is topped up after every key.
 */
function keepBackspaceRepeating (t) {
    const ta = t.textarea
    const FILL = '​'.repeat(8)
    let composing = false
    const refill = () => setTimeout(() => {
        if (composing || ta.value === FILL || document.activeElement !== ta) return
        ta.value = FILL
        ta.setSelectionRange(FILL.length, FILL.length)
    })
    ta.addEventListener('compositionstart', () => { composing = true })
    ta.addEventListener('compositionend', () => { composing = false; refill() })
    for (const type of ['focus', 'input', 'keyup']) ta.addEventListener(type, refill)
}

// ---- Keyboard: keep the page in the visible area, so the prompt stays above the phone keyboard ----

const vv = window.visualViewport
if (vv) {
    // The keyboard can only be up while a text field has focus.
    const typing = () => document.activeElement?.matches?.('textarea, input:not([type=button]):not([type=checkbox]):not([type=file])')
    const follow = () => {
        const root = document.documentElement.style
        if (typing()) {
            root.setProperty('--vvh', `${vv.height}px`)
            root.setProperty('--vvtop', `${vv.offsetTop}px`)
        } else {
            // No keyboard: the whole screen. iOS can keep reporting the keyboard-up height after a rotation.
            root.removeProperty('--vvh')
            root.removeProperty('--vvtop')
        }
        // Keyboard up (the visible area is well short of the window): the home-indicator gap at the bottom is
        // covered by the keyboard, so the key bar must sit right on top of it. Matters in the Home Screen app,
        // where that gap is real; in Safari it is already 0.
        document.body.classList.toggle('keyboard', !!typing() && window.innerHeight - vv.height > 120)
        window.scrollTo(0, 0)
        // The terminal box shrank; its ResizeObserver refits, then we show the cursor line.
        requestAnimationFrame(() => term?.scrollToBottom())
    }
    vv.addEventListener('resize', follow)
    vv.addEventListener('scroll', follow)
    // iOS reports mid-rotation sizes and may not send a final one: measure again once the rotation has settled.
    window.addEventListener('orientationchange', () => [100, 400, 800].forEach(ms => setTimeout(follow, ms)))
    // The keyboard opens on focus and closes on blur; iOS's own resize can come late or not at all.
    document.addEventListener('focusin', follow)
    document.addEventListener('focusout', () => [0, 300].forEach(ms => setTimeout(follow, ms)))
    follow()
}
