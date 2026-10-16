// ---- Claude's questions as buttons ----

/**
 * The open question on screen, as its options' text: Claude's numbered list with its ❯ marker ("❯ 1. Yes",
 * "2. No"), the last one on screen, with nothing after it but its footer. Once answered, Claude's input box (❯ at the
 * line start) comes back below it, and the list no longer counts.
 */
function choicesOn (t) {
    const b = t.buffer.active
    let found = null
    let cur = null
    let after = 0
    for (let y = b.viewportY; y < b.viewportY + t.rows; y++) {
        const line = b.getLine(y)?.translateToString(true) ?? ''
        const m = line.match(/^\s*(❯\s*)?(\d)\.\s+(.+)$/)
        if (m && (m[2] === '1' || (cur && Number(m[2]) === cur.options.length + 1))) {
            if (m[2] === '1') cur = { options: [], marked: false }
            cur.options.push(m[3].trim())
            cur.marked ||= !!m[1]
            cur.indent = line.length - m[3].length
            if (cur.marked && cur.options.length >= 2) {
                found = cur
                after = 0
            }
            continue
        }
        // A long option wraps onto lines indented under its text.
        if (cur && line.trim() && line.search(/\S/) >= cur.indent) {
            cur.options[cur.options.length - 1] += ' ' + line.trim()
            continue
        }
        cur = null
        if (found && line.trim() && (/^❯/.test(line) || ++after > 4)) found = null
    }
    return found?.options ?? null
}

function watchChoices (t) {
    $('answers').hidden = true
    let shown = ''
    let queued = false
    const update = () => {
        queued = false
        if (t !== term) return
        const options = choicesOn(t)
        const key = JSON.stringify(options)
        if (key === shown) return
        shown = key
        $('answers').hidden = !options
        $('answers').replaceChildren(...(options ? [el('div', {}, ...options.map((text, i) =>
            // Claude takes the option's number as the answer at once.
            el('button', { onclick: () => sendKey(String(i + 1)) }, el('b', { textContent: i + 1 }), text)))] : []))
    }
    const queue = () => {
        if (queued) return
        queued = true
        setTimeout(update, 120)
    }
    t.onWriteParsed(queue)
    t.onScroll(queue)
    t.onResize(queue)
    queue()
}
// Answering leaves the phone keyboard as it was.
$('answers').addEventListener('pointerdown', e => e.preventDefault())
