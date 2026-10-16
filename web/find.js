// ---- Search: Tabby's own (Ctrl+Shift+F), with a match count, up/down, case, regex and whole word ----

const findOpts = { caseSensitive: false, regex: false, wholeWord: false, ...saved('find') }
const MATCHES = { matchBackground: '#5c4a10', activeMatchBackground: '#c08a00', matchOverviewRuler: '#888888', activeMatchColorOverviewRuler: '#ffb000' }

async function openFind () {
    if (!term) return
    // Loaded on first use, so the page still works on a Tabby that does not serve it yet.
    if (!window.SearchAddon) await new Promise(resolve => document.head.append(el('script', { src: 'addon-search.js', onload: resolve, onerror: resolve })))
    if (!window.SearchAddon) return flash('Needs a Tabby restart')
    if (!term.__find) {
        const s = term.__find = new SearchAddon.SearchAddon()
        term.loadAddon(s)
        s.onDidChangeResults(({ resultIndex, resultCount }) => {
            const text = $('find-text').value
            $('find-count').textContent = text && resultCount ? `${resultIndex + 1} / ${resultCount}` : ''
            $('find-text').classList.toggle('none', !!text && !resultCount)
            $('find-prev').hidden = $('find-next').hidden = !(text && resultCount)
        })
    }
    $('find').hidden = false
    $('find-text').focus()
    $('find-text').select()
    if ($('find-text').value) find(1, true)
}

function closeFind () {
    if ($('find').hidden) return
    $('find').hidden = true
    term?.__find?.clearDecorations()
    term?.clearSelection()
    $('find-text').blur()
}

function find (dir, incremental = false) {
    const s = term?.__find
    const text = $('find-text').value
    if (!s) return
    if (!text) {
        s.clearDecorations()
        term.clearSelection()
        $('find-count').textContent = ''
        $('find-text').classList.remove('none')
        $('find-prev').hidden = $('find-next').hidden = true
        return
    }
    const o = { ...findOpts, incremental, decorations: MATCHES }
    if (dir < 0) s.findPrevious(text, o)
    else s.findNext(text, o)
}

$('find-btn').onclick = () => $('find').hidden ? openFind() : closeFind()
$('find-close').onclick = closeFind
$('find-prev').onclick = () => find(-1)
$('find-next').onclick = () => find(1)
$('find-text').addEventListener('input', () => find(1, true))
$('find-text').addEventListener('keydown', e => {
    if (e.key === 'Enter') {
        e.preventDefault()
        find(e.shiftKey ? -1 : 1)
    } else if (e.key === 'Escape') {
        closeFind()
        term?.focus()
    }
})
for (const [id, key] of [['find-case', 'caseSensitive'], ['find-regex', 'regex'], ['find-word', 'wholeWord']]) {
    $(id).ariaPressed = String(findOpts[key])
    $(id).onclick = () => {
        findOpts[key] = !findOpts[key]
        $(id).ariaPressed = String(findOpts[key])
        remember('find', findOpts)
        find(1, true)
    }
}
// The search bar's buttons leave the keyboard up for the search box.
$('find').addEventListener('pointerdown', e => e.target.closest('button') && e.preventDefault())
document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        openFind()
    }
}, true)
