// ---- Keyboard predictions (a ⚙ setting on touch screens) ----
// The phone keyboard only predicts words for a text box it can read. With the setting on, typing goes into an
// invisible box that holds what was typed on this line since its last reset; each change (a key, a tapped
// prediction, dictation) is passed to the terminal at once as deletes plus new text. Anything that changes the line
// another way (Return, a key-bar key, a tap on the terminal, another tab) resets the box, so it never deletes text
// it did not type. Autocorrect follows the phone's own setting.

let predicting = touch.matches && !!saved('predictions')
// Something to delete at the start of a line, so ⌫ still reaches the terminal there (and repeats when held). Plain
// spaces: iOS shows no predictions after unusual characters.
const PAD = ' '.repeat(4)
const predictBox = el('textarea', { id: 'predict', rows: 1, spellcheck: true, tabIndex: -1, ariaLabel: 'Typing' })
predictBox.setAttribute('autocorrect', 'on')
predictBox.setAttribute('autocapitalize', 'off')
document.body.append(predictBox)
let typed = []

function resetPredict () {
    typed = []
    predictBox.value = PAD
    predictBox.setSelectionRange(PAD.length, PAD.length)
}

function setPredicting (on) {
    predicting = on
    remember('predictions', on)
    if (!on && document.activeElement === predictBox) term?.focus()
}

/** Where typing goes after a tap on the terminal: the predictions box, or the terminal itself. */
function typeHere (t) {
    const box = predicting ? predictBox : t.textarea
    if (predicting) resetPredict()
    // iOS can put its keyboard away while the box keeps focus; focusing it again then shows nothing. Blur first.
    if (document.activeElement === box) box.blur()
    box.focus({ preventScroll: true })
}

predictBox.addEventListener('beforeinput', e => {
    // Return: Enter to the terminal, and a fresh line.
    if (e.inputType !== 'insertLineBreak' && e.inputType !== 'insertParagraph') return
    e.preventDefault()
    sendKey('\r')
    resetPredict()
})

predictBox.addEventListener('input', () => {
    const value = predictBox.value
    // A selection on the line being typed: this key replaces it (⌫ deletes it).
    const sel = term && takeSelection(term)
    if (sel) {
        const before = PAD.length + typed.length
        const chars = [...value]
        return replaceSelection(term, chars.length < before ? '\x7f' : chars.slice(before).join(''), sel)
    }
    // The padding is the first PAD.length spaces; spaces typed at the start of the line come after it.
    const pad = Math.min(value.match(/^ */)[0].length, PAD.length)
    const now = [...value.slice(pad)]
    // ⌫ into the padding deletes before this line's start, in the terminal.
    let dels = PAD.length - pad
    let same = 0
    while (same < typed.length && same < now.length && typed[same] === now[same]) same++
    dels += typed.length - same
    const add = now.slice(same).join('')
    if (dels > 0) sendKey('\x7f'.repeat(dels))
    if (add) sendKey(applyMods(add))
    typed = now
    if (pad !== PAD.length) {
        predictBox.value = PAD + now.join('')
        predictBox.setSelectionRange(predictBox.value.length, predictBox.value.length)
    }
})

// A paste (Cmd/Ctrl+V, or the phone's Paste) goes to the terminal as a paste, bracketed when the app asked for it,
// not as typed letters. The paste event carries the text even on plain http, where the clipboard API is missing.
predictBox.addEventListener('paste', e => {
    const text = e.clipboardData?.getData('text')
    e.preventDefault()
    if (text) term?.paste(text)
    resetPredict()
})

// A hardware keyboard's keys that are not text.
predictBox.addEventListener('keydown', e => {
    const named = { Escape: 'esc', Tab: 'tab', ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right', Home: 'home', End: 'end', PageUp: 'pgup', PageDown: 'pgdn' }[e.key]
    const ctrl = e.ctrlKey && e.key.length === 1 && /[a-z]/i.test(e.key) ? String.fromCharCode(e.key.toUpperCase().charCodeAt(0) & 31) : null
    if (!named && !ctrl) return
    e.preventDefault()
    resetPredict()
    sendKey(ctrl ?? (KEYS[named] ?? keySeq(named)))
})
