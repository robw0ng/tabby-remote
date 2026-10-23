// ---- Claude's questions as buttons ----

// The row for an answer of one's own: "Type something." (a single choice) or "[ ] Type something" (several).
const FREE_TEXT = /^(\[[ ✔x]\]\s*)?(Type something|Other)\b/i
// Whether Claude is asking right now: its text row then takes typed keys one at a time (see terminal.js).
let claudeAsking = false

/**
 * The open question on screen: its options' text, and which one has Claude's ❯ cursor. Claude's numbered list
 * ("❯ 1. Yes", "2. No"), the last one on screen, with nothing after it but its footer. Once answered, Claude's input
 * box (❯ at the line start) comes back below it, and the list no longer counts.
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
            if (m[2] === '1') cur = { options: [], markedAt: -1 }
            cur.options.push(m[3].trim())
            if (m[1]) cur.markedAt = cur.options.length - 1
            cur.indent = line.length - m[3].length
            if (cur.markedAt >= 0 && cur.options.length >= 2) {
                found = cur
                after = 0
            }
            continue
        }
        // A long option wraps onto lines indented under its text. Several choices end in a Submit line, not an option.
        if (cur && line.trim() && line.trim() !== 'Submit' && line.search(/\S/) >= cur.indent) {
            cur.options[cur.options.length - 1] += ' ' + line.trim()
            continue
        }
        cur = null
        // After the list come its footer lines (Submit, Chat about this, the key hints, wrapped on a phone).
        if (found && line.trim() && (/^❯/.test(line) || ++after > 6)) found = null
    }
    return found && { options: found.options, markedAt: found.markedAt }
}

function watchChoices (t) {
    $('answers').hidden = true
    claudeAsking = false
    let shown = ''
    let folded = '' // the question whose options were put away (Hide, or typing an answer), until the next question
    let freeAt = -1 // the answer-of-one's-own row: what is typed there is still the same question
    let choices = null
    const render = () => {
        const options = choices?.options
        $('answers').hidden = !options
        if (!options) return $('answers').replaceChildren()
        if (folded === shown) {
            return $('answers').replaceChildren(el('button', { className: 'answers-show', textContent: `Options (${options.length})`, onclick: () => { folded = ''; render() } }))
        }
        $('answers').replaceChildren(el('div', {},
            el('button', { className: 'answers-hide', textContent: 'Hide', onclick: () => { folded = shown; render() } }),
            ...options.map((text, i) => el('button', { onclick: () => pick(i) }, el('b', { textContent: i + 1 }), text))))
    }
    // Claude takes an option's number as the answer at once. The answer-of-one's-own row is typed into instead: a
    // single choice opens it by its number, several choices need Claude's cursor on it (↑/↓; its number only ticks it).
    // Then the options fold away and the keyboard comes up, so the line being typed shows.
    const pick = i => {
        if (!FREE_TEXT.test(choices.options[i])) return sendKey(String(i + 1))
        if (choices.options[i].startsWith('[')) {
            const steps = i - choices.markedAt
            for (let n = 0; n < Math.abs(steps); n++) sendKey(keySeq(steps > 0 ? 'down' : 'up'))
        } else {
            sendKey(String(i + 1))
        }
        folded = shown
        render()
        typeHere(t)
    }
    let queued = false
    const update = () => {
        queued = false
        if (t !== term) return
        $('back-chip').hidden = !agentList(t)
        choices = choicesOn(t)
        claudeAsking = !!choices
        if (!choices) freeAt = -1
        const at = choices?.options.findIndex(o => FREE_TEXT.test(o)) ?? -1
        if (at >= 0) freeAt = at
        const key = JSON.stringify(choices?.options.map((o, i) => i === freeAt ? '' : o) ?? null)
        if (key === shown) return
        shown = key
        render()
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
/**
 * Claude's agent list under its input while subagents run ("● main", "◯ general-purpose …"; ● is the view on
 * screen, ❯ the list's cursor), when a subagent's view is open (main is ◯): its rows, and which one has the cursor.
 */
function agentList (t) {
    const b = t.buffer.active
    const rows = []
    for (let y = b.viewportY; y < b.viewportY + t.rows; y++) {
        const m = (b.getLine(y)?.translateToString(true) ?? '').match(/^\s*(❯\s*)?([◯●]) (\S+)/)
        if (m && (rows.length || m[3] === 'main')) rows.push(m)
        else if (rows.length) break
    }
    if (rows[0]?.[2] !== '◯') return null
    return { cursor: rows.findIndex(m => m[1]) }
}
// Back to main, as on a computer: ↓ opens the list on main (or ↑ to it when the list is open), Enter shows it, and
// ↑ closes the list, so the cursor is back in the input. (Esc would not go back: it interrupts the subagent.) A
// moment between keys, so Claude reads each one.
$('back-chip').addEventListener('pointerdown', e => e.preventDefault())
$('back-chip').onclick = () => {
    const list = term && agentList(term)
    if (!list) return
    const keys = [...(list.cursor < 0 ? [keySeq('down')] : Array(list.cursor).fill(keySeq('up'))), '\r', keySeq('up')]
    keys.forEach((k, i) => setTimeout(() => sendKey(k), i * 120))
}
// Answering leaves the phone keyboard as it was; a tap between the options brings it back (to type an answer).
$('answers').addEventListener('pointerdown', e => e.preventDefault())
$('answers').addEventListener('click', e => term && !e.target.closest('button') && typeHere(term))
