const os = require('os')
const { hashPassword } = require('./secrets')
const { phoneAddress } = require('./net')

// Tabby's right-column field width, also for a field that shares its row with buttons.
const FIELD = 'width:198px;flex:none'

const h = (tag, props = {}, ...kids) => {
    const e = Object.assign(document.createElement(tag), props)
    e.append(...kids.filter(k => k != null))
    return e
}

const ago = t => {
    const m = Math.round((Date.now() - (t ?? 0)) / 60000)
    return m < 2 ? 'just now' : m < 60 ? `${m} min ago` : m < 48 * 60 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`
}

// Tabby's own row: title and description on the left, the control in the right column (Tabby's CSS sizes a
// form-control there; extra buttons sit to its left, so every field and toggle shares one right edge).
function line (title, description, control, ...before) {
    const note = h('span', { className: 'ms-2 text-success' })
    const row = h('div', { className: 'form-line' },
        h('div', { className: 'header' }, h('div', { className: 'title' }, title, note), description && h('div', { className: 'description', textContent: description })),
        before.length ? h('div', { className: 'd-flex align-items-center gap-2' }, ...before, control) : control)
    row.saved = () => {
        note.textContent = '✓ Saved'
        setTimeout(() => { note.textContent = '' }, 1500)
    }
    return row
}

const toggle = (on, change) => h('div', { className: 'form-check form-switch ms-auto mb-0' },
    h('input', { className: 'form-check-input', type: 'checkbox', role: 'switch', checked: on, onchange: e => change(e.target.checked) }))

const button = (text, onclick) => h('button', { className: 'btn btn-secondary text-nowrap', textContent: text, onclick })

/** Tabby's Settings > Phone access, in the look of Tabby's own pages (form-line rows, Bootstrap controls). */
module.exports = ctx => {
    const { store } = ctx

    function renderSettings (host) {
        const rerender = () => renderSettings(host)
        const set = (key, value) => {
            store[key] = value
            ctx.save()
        }
        /** A field saved on Enter or on leaving it, with a short "Saved" next to its title. */
        const field = (title, description, props, apply) => {
            const input = h('input', { className: 'form-control', style: FIELD, ...props })
            const row = line(title, description, input)
            input.addEventListener('change', () => {
                if (apply(input.value) === false) return
                ctx.save()
                row.saved()
            })
            input.addEventListener('keydown', e => e.key === 'Enter' && input.blur())
            return { input, row }
        }

        const address = `http://${phoneAddress()}:${ctx.listeningPort}`
        const port = field('Port', ctx.listeningPort === store.port ? 'Applies after restarting Tabby.' : `Applies after restarting Tabby. Still on ${ctx.listeningPort} until then.`,
            { type: 'number', min: 1024, max: 65535, value: store.port }, v => {
                const n = Math.round(Number(v))
                if (!(n >= 1024 && n <= 65535)) return false
                store.port = n
                rerender()
            })
        const name = field('Computer name', 'What phones call this computer: their header and its Home Screen icon (add the icon again after a change).',
            { type: 'text', value: store.name ?? '', placeholder: os.hostname(), maxLength: 40 }, v => {
                store.name = v.trim().slice(0, 40) || null
            })
        const days = field('Days unused before forgetting', null, { type: 'number', min: 1, max: 365, value: store.forgetDays, disabled: !store.autoForget }, v => {
            store.forgetDays = Math.max(1, Math.min(365, Math.round(Number(v) || 30)))
        })
        const minutes = field('Minutes awake after the last device leaves', 'A phone that locks drops its connection; this keeps the computer reachable when it comes back.',
            { type: 'number', min: 0, max: 1440, value: store.awakeMinutes, disabled: !store.keepAwake && !store.keepScreen }, v => {
                store.awakeMinutes = Math.max(0, Math.min(1440, Math.round(Number(v) || 0)))
            })

        // The password is never shown or echoed back: the field is only for typing a new one.
        const pw = h('input', { className: 'form-control', style: FIELD, type: 'password', placeholder: store.passwordHash ? 'Set' : 'Not set', autocomplete: 'new-password' })
        const setPassword = () => {
            if (!pw.value) return
            set('passwordHash', hashPassword(pw.value))
            rerender()
        }
        pw.addEventListener('keydown', e => e.key === 'Enter' && setPassword())

        /** One row per computer to send to: the ones seen now, and linked ones that are away. */
        const linkRows = seenNow => {
            const away = Object.entries(store.links ?? {}).filter(([id]) => !seenNow.some(c => c.computerId === id)).map(([computerId, l]) => ({ computerId, name: l.name, linked: true, away: true }))
            const rows = [...ctx.moveTargets(), ...away].map(c => {
                if (c.linked) {
                    return line(c.name, c.away ? 'Linked. Not on this network right now.' : 'Linked.', button('Unlink', () => {
                        ctx.unlink(c.computerId)
                        rerender()
                    }))
                }
                const secret = h('input', { className: 'form-control', style: FIELD, type: 'password', placeholder: 'Password or QR code', autocomplete: 'off' })
                const go = async () => {
                    if (!secret.value) return
                    const r = await ctx.link(c.computerId, secret.value)
                    if (!r.ok) ctx.notifications.error(`${c.name}: ${r.error}`)
                    rerender()
                }
                secret.addEventListener('keydown', e => e.key === 'Enter' && go())
                return line(c.name, 'Not linked: type its password, or the 6-digit code from its QR button.', secret, button('Link', go))
            })
            return rows.length ? rows : [h('p', { className: 'text-muted', textContent: 'No other computers seen on this network.' })]
        }

        const live = ctx.connectedIds()
        const seen = ctx.otherComputers()
        const devices = [...store.devices].sort((a, b) => (b.lastSeen ?? 0) - (a.lastSeen ?? 0)).map(d => h('div', { className: 'list-group-item d-flex align-items-center' },
            h('span', { style: `display:inline-block;flex:none;width:10px;height:10px;border-radius:50%;margin-right:10px;background:${ctx.colorOf(d)}` }),
            h('div', { className: 'me-auto' },
                h('div', { textContent: d.name }),
                h('small', { className: 'text-muted', textContent: `Paired ${new Date(d.created).toLocaleDateString()} · ${live.has(d.id) ? 'connected now' : `last seen ${ago(d.lastSeen)}`}` })),
            h('button', {
                className: 'btn btn-outline-danger btn-sm',
                textContent: 'Remove',
                onclick: () => {
                    ctx.removeDevice(d)
                    rerender()
                },
            })))

        host.replaceChildren(
            h('h3', { className: 'mb-3', textContent: 'Connection' }),
            line('Phone access', 'Off: nothing listens on the network and connected devices are dropped. They stay paired.',
                toggle(store.enabled, on => {
                    set('enabled', on)
                    if (on) ctx.startServers().then(rerender)
                    else ctx.stopServers()
                    rerender()
                })),
            line('Address', 'Open it on a phone or tablet on the same Wi-Fi, or scan the QR.', h('input', { className: 'form-control', style: FIELD, type: 'text', readOnly: true, value: address }),
                button('Copy', e => {
                    ctx.writeClipboard(address)
                    e.target.textContent = 'Copied'
                    setTimeout(() => { e.target.textContent = 'Copy' }, 1200)
                }),
                button('Show QR', () => ctx.showQr())),
            port.row,
            line('Show this computer to my other computers', `Lets a phone signed in to another computer on this Wi-Fi list this one (signing in here still needs its own code). ${seen.length ? `Seen now: ${seen.map(p => p.name).join(', ')}.` : 'No other computers seen right now.'}`,
                toggle(store.announce, on => {
                    set('announce', on)
                    ctx.announce()
                })),

            h('h3', { className: 'mt-4 mb-3', textContent: 'Send to computer' }),
            h('p', { className: 'text-muted', textContent: ctx.canMove()
                ? 'Moves a Claude chat to another of your computers on this network, which opens it in a new tab: right-click a Claude tab › Send to computer. Compact a big chat and push its branch first. Each computer is linked once.'
                : 'Moves a Claude chat to another of your computers. Needs the claude-sessions plugin.' }),
            ...ctx.canMove() ? linkRows(seen) : [],

            h('h3', { className: 'mt-4 mb-3', textContent: 'This computer' }),
            name.row,

            h('h3', { className: 'mt-4 mb-3', textContent: 'Security' }),
            line('Password', store.passwordHash ? 'Sign in with this password instead of a QR code. Type a new one to change it.' : 'Optional: sign in with a password instead of a QR code.', pw,
                button('Set', setPassword),
                store.passwordHash ? button('Remove', () => {
                    set('passwordHash', null)
                    rerender()
                }) : null),
            line('Forget unused devices', 'A private browser tab pairs as a new device each time. Forgotten: devices not seen for the days below, and ones never used after the visit they paired in (after a day). Never one connected now.',
                toggle(store.autoForget, on => {
                    set('autoForget', on)
                    days.input.disabled = !on
                    if (on) ctx.forgetUnused()
                    rerender()
                })),
            days.row,
            line('Paired devices', 'Remove one to sign it out at once.', button(`Remove unused (${ctx.unusedDevices().length})`, () => {
                ctx.forgetUnused()
                rerender()
            })),
            devices.length
                ? h('div', { className: 'list-group mb-3' }, ...devices)
                : h('p', { className: 'text-muted', textContent: 'None yet. Scan the QR on a phone to add one.' }),

            h('h3', { className: 'mt-4 mb-3', textContent: 'Power' }),
            line('Keep this computer awake', 'While a device has a tab open, the computer does not go to sleep. The screen may still turn off.',
                toggle(store.keepAwake, on => {
                    set('keepAwake', on)
                    ctx.stayAwake()
                    minutes.input.disabled = !on && !store.keepScreen
                })),
            line('Keep the screen on while a device is connected', 'Stops the screen turning off, and with it the lock and standby that can pause Tabby on a laptop. Your computer stays unlocked and unattended while connected.',
                toggle(!!store.keepScreen, on => {
                    set('keepScreen', on)
                    ctx.stayAwake()
                    minutes.input.disabled = !on && !store.keepAwake
                })),
            minutes.row,
        )
    }

    return { renderSettings }
}
