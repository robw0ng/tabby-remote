// ---- This device's settings (⚙), adding a device, and switching computers ----

/**
 * Which groups are collapsed: Tabby's (tabby-groups), so folding on either side shows on both; or, when this
 * device keeps its own (⚙ in the sidebar), this device's, remembered here. A group new to this device starts open.
 */
let foldMode = saved('foldMode') ?? 'tabby'
let ownFolds = saved('folds') ?? {}
const isShut = g => foldMode === 'device' ? !!ownFolds[g.name] : !!g.collapsed

/** This device's settings, as a menu: for now, whose collapsed groups the sidebar shows. */
function settingsMenu () {
    const pick = mode => {
        // Switching to this device's own starts from what is shown now.
        if (mode === 'device' && foldMode !== 'device') ownFolds = Object.fromEntries(groups.map(g => [g.name, !!g.collapsed]))
        foldMode = mode
        remember('foldMode', mode)
        remember('folds', ownFolds)
        renderTree()
    }
    const r = $('settings').getBoundingClientRect()
    showMenu([
        { label: 'Collapsed groups' },
        { text: 'Synced with Tabby', checked: foldMode === 'tabby', run: () => pick('tabby') },
        { text: 'This device only', checked: foldMode === 'device', run: () => pick('device') },
        { label: 'Devices' },
        { text: 'Add another device…', run: addDevice },
        // Touch screens: the phone keyboard's word predictions (autocorrect follows the phone's own setting).
        ...touch.matches ? [
            { label: 'Keyboard predictions' },
            { text: 'On', checked: predicting, run: () => setPredicting(true) },
            { text: 'Off', checked: !predicting, run: () => setPredicting(false) },
        ] : [],
    ], r.left, r.bottom)
}
$('settings').onclick = settingsMenu

// ---- Add another device: this signed-in device shows a pairing QR and code for the next one ----

async function addDevice () {
    const r = await api('/api/pairing', { method: 'POST' }).catch(() => null)
    if (!r?.ok) return flash(r?.status === 404 ? 'Needs a Tabby restart' : 'Could not make a code')
    const { code, expires, svg } = await r.json()
    const left = el('span')
    const qr = el('div', { className: 'pair-qr' })
    qr.innerHTML = svg
    const node = el('div', { className: 'pair-box' },
        qr,
        el('div', { className: 'pair-code', textContent: code }),
        el('p', { textContent: 'Scan it with the other device\'s camera, or enter the code on its sign-in screen. Single use.' }),
        left)
    const tick = () => {
        const s = Math.max(0, Math.ceil((expires - Date.now()) / 1000))
        left.textContent = s ? `Valid for ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` : 'Expired: open it again for a new code'
        if (s && !$('menu').hidden) setTimeout(tick, 1000)
    }
    showMenu([{ label: 'Add another device' }, { node }, { text: 'Done', run () {} }])
    tick()
}

// ---- Other computers: the Tabbys this one has heard on the network; tap one to open it ----

$('term-host').onclick = async () => {
    const r = await api('/api/computers').catch(() => null)
    const others = r?.ok ? await r.json() : []
    const anchor = $('term-host').getBoundingClientRect()
    showMenu([
        { label: 'Computers' },
        { text: computer || location.host, checked: true, run () {} },
        ...others.sort((a, b) => a.name.localeCompare(b.name)).map(c => ({ text: c.name, run: () => { location.href = c.url } })),
        ...others.length ? [] : [{ label: r?.ok ? 'No other computers seen on this Wi-Fi.' : 'Needs a Tabby restart.' }],
    ], anchor.left, anchor.bottom)
}
