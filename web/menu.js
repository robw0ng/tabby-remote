// ---- The menu: an action sheet on phones, a popover at the pointer with a mouse ----

function showMenu (items, x, y) {
    const box = $('menu-card')
    box.replaceChildren(...items.map(it => {
        if (it.swatches) {
            return el('div', { className: 'swatches' }, ...it.swatches.map(([label, color]) => el('button', {
                className: 'swatch' + (color ? '' : ' none') + (it.current === color ? ' on' : ''),
                title: label,
                ariaLabel: label,
                style: color ? `background:${color}` : '',
                onclick: () => { hideMenu(); it.pick(color) },
            })))
        }
        if (it.node) return it.node
        if (it.peek) {
            const pre = el('pre', { className: 'peek', textContent: '…' })
            // A server that cannot peek (an older one, until Tabby restarts) just shows no preview.
            api(`/api/sessions/${it.peek}/peek?lines=12`).then(r => r.ok ? r.json() : Promise.reject(r)).then(({ lines }) => {
                pre.textContent = lines.length ? lines.join('\n') : '(nothing on screen yet)'
                pre.scrollTop = pre.scrollHeight
            }).catch(() => pre.remove())
            return pre
        }
        if (it.sep) return el('div', { className: 'menu-sep' })
        if (it.label && !it.run) return el('div', { className: 'menu-label', textContent: it.label })
        return el('button', {
            className: 'menu-item' + (it.danger ? ' danger' : ''),
            style: it.depth ? `padding-left:${10 + it.depth * 14}px` : '',
            textContent: it.text + (it.checked ? ' ✓' : ''),
            onclick: () => { if (!it.keepOpen) hideMenu(); it.run() },
        })
    }))
    $('menu').hidden = false
    $('menu').classList.toggle('sheet', narrow.matches || x == null)
    if (!narrow.matches && x != null) {
        const r = box.getBoundingClientRect()
        box.style.left = `${Math.min(x, innerWidth - r.width - 4)}px`
        box.style.top = `${Math.min(y, innerHeight - r.height - 4)}px`
    } else {
        box.style.left = box.style.top = ''
    }
}
function hideMenu () {
    $('menu').hidden = true
}
$('menu').addEventListener('click', e => e.target === $('menu') && hideMenu())
document.addEventListener('keydown', e => e.key === 'Escape' && !$('menu').hidden && hideMenu())

/** A one-line text box in the bottom sheet; resolves with the text, or null when closed. */
function prompt2 (title, value) {
    return new Promise(resolve => {
        const box = $('sheet-text')
        $('sheet').dataset.kind = 'prompt'
        $('sheet-title').textContent = title
        $('sheet-go').textContent = 'Save'
        $('sheet-extra').replaceChildren()
        box.readOnly = false
        box.value = value
        box.placeholder = ''
        $('sheet').hidden = false
        box.focus()
        box.select()
        promptDone = text => {
            promptDone = null
            $('sheet').hidden = true
            box.blur()
            resolve(text)
        }
    })
}
let promptDone = null
