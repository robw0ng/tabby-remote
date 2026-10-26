const os = require('os')
const core = require('tabby-core')
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

/** Tabby's Settings > Devices (phones, browsers and linked computers), in the look of Tabby's own pages (form-line rows, Bootstrap controls). */
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
        const name = field('Computer name', 'What your phones and other computers call this one: a phone\'s header and Home Screen icon (add the icon again after a change), and its name on your other computers (after they link again).',
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

        /** Before linking: the computer answering shows this fingerprint; is it the one that computer shows? The verified
         *  fingerprint leads; the name (anyone's to announce, one plain line) only follows, quoted. */
        const confirmFingerprint = async (name, fingerprint, changed) => (await ctx.injector.get(core.PlatformService).showMessageBox({
            type: changed ? 'warning' : 'question',
            message: `Fingerprint ${fingerprint}`,
            detail: (changed ? `This is NOT the identity "${name}" had when you last linked it. Only go on if you reset Tabby there.\n\n` : '') + `The computer answering as "${name}" shows this fingerprint. Link only if ${name}'s own Settings › Devices › This computer (or the line under its QR) shows the same. If not, something else on this network is pretending to be it: cancel.`,
            buttons: ['Link', 'Cancel'],
            defaultId: 1,
            cancelId: 1,
        })).response === 0

        /** One row per computer: the ones seen now, and linked ones that are away. */
        const linkRows = seenNow => {
            const away = Object.entries(store.links ?? {}).filter(([id]) => !seenNow.some(c => c.computerId === id)).map(([computerId, l]) => ({ computerId, name: l.name, linked: true, away: true }))
            const rows = [...ctx.moveTargets(), ...away].map(c => {
                if (c.linked) {
                    const both = store.devices.some(d => d.computer && d.computerId === c.computerId)
                    return line(c.name, (both ? 'Linked both ways.' : 'Linked from here. Link it again to let it reach this computer too.') + (c.away ? ' Not on this network right now.' : ''),
                        button('Unlink', async () => {
                            await ctx.unlink(c.computerId)
                            rerender()
                        }))
                }
                const secret = h('input', { className: 'form-control', style: FIELD, type: 'password', placeholder: 'Code or password', autocomplete: 'off' })
                const go = async () => {
                    if (!secret.value) return
                    const r = await ctx.link(c.computerId, secret.value, confirmFingerprint)
                    // The error can come from whatever answered: one short plain line.
                    if (!r.ok && !r.cancelled) ctx.notifications.error(`${c.name}: ${String(r.error).replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ').slice(0, 160)}`)
                    else if (r.ok && !r.back) ctx.notifications.notice(`Linked to ${c.name}, but it could not link back: update tabby-remote there, then link again`)
                    rerender()
                }
                secret.addEventListener('keydown', e => e.key === 'Enter' && go())
                return line(c.name, `Not linked. Click the QR button next to Settings on ${c.name} and type its 6-digit code here (or its password).`, secret, button('Link', go))
            })
            return rows.length ? rows : [h('p', { className: 'text-muted', textContent: 'No other computers seen on this network. Each needs Tabby with tabby-remote running, and "Show this computer on my network" on.' })]
        }

        /** The folders linked computers may use, one row each, then a field to add one. */
        const folderRows = () => {
            const add = h('input', { className: 'form-control', style: FIELD, type: 'text', placeholder: 'Full path of a folder', autocomplete: 'off' })
            const go = async () => {
                const error = await ctx.shareFolder(add.value)
                if (error) return ctx.notifications.error(error)
                rerender()
            }
            add.addEventListener('keydown', e => e.key === 'Enter' && go())
            return [
                ...store.sharedFolders.map(p => line(p, null, button('Stop sharing', () => {
                    ctx.unshareFolder(p)
                    rerender()
                }))),
                line('Share a folder', store.sharedFolders.length
                    ? 'Your linked computers can browse, copy, move and delete files in these folders (deleted files go to the Recycle Bin / Trash). Phones and browsers (📁 on the page) can browse, download and upload new files.'
                    : 'None: no files are reachable from other devices. Add a folder to let your linked computers and phones use it.',
                add, button('Share', go)),
            ]
        }

        const live = ctx.connectedIds()
        const seen = ctx.otherComputers()
        const deviceList = list => [...list].sort((a, b) => (b.lastSeen ?? 0) - (a.lastSeen ?? 0)).map(d => h('div', { className: 'list-group-item d-flex align-items-center' },
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
        const phones = deviceList(store.devices.filter(d => !d.computer))
        const computers = deviceList(store.devices.filter(d => d.computer))
        const uses = ['their Claude chats can message each other (tab-say --computer)', 'they use each other\'s Shared folders (the Files tab)',
            ...ctx.canMove() ? ['you can move a Claude chat over: right-click a Claude tab › Send to computer'] : []]

        host.replaceChildren(
            h('p', { className: 'text-muted', textContent: 'Use this computer\'s terminals from a phone or browser, and link your other computers to it. Home network (or Tailscale) only.' }),
            h('h3', { className: 'mb-3', textContent: 'Connection' }),
            line('Allow connections', 'Off: nothing listens on the network, and phones and linked computers are disconnected. They stay paired.',
                toggle(store.enabled, on => {
                    set('enabled', on)
                    if (on) ctx.startServers().then(rerender)
                    else ctx.stopServers()
                    rerender()
                })),
            port.row,

            h('h3', { className: 'mt-4 mb-3', textContent: 'Phones and browsers' }),
            line('Address', 'Open it on a phone or tablet on the same Wi-Fi, or scan the QR.', h('input', { className: 'form-control', style: FIELD, type: 'text', readOnly: true, value: address }),
                button('Copy', e => {
                    ctx.writeClipboard(address)
                    e.target.textContent = 'Copied'
                    setTimeout(() => { e.target.textContent = 'Copy' }, 1200)
                }),
                button('Show QR', () => ctx.showQr())),
            line('Password', store.passwordHash ? 'Sign in with this password instead of a QR code. Type a new one to change it.' : 'Optional: sign in with a password instead of a QR code.', pw,
                button('Set', setPassword),
                store.passwordHash ? button('Remove', () => {
                    set('passwordHash', null)
                    rerender()
                }) : null),
            line('Forget unused phones and browsers', 'A private browser tab pairs as a new device each time. Forgotten: ones not seen for the days below, and ones never used after the visit they paired in (after a day). Never one connected now, and never a linked computer.',
                toggle(store.autoForget, on => {
                    set('autoForget', on)
                    days.input.disabled = !on
                    if (on) ctx.forgetUnused()
                    rerender()
                })),
            days.row,
            line('Paired phones and browsers', 'Remove one to sign it out at once.', button(`Remove unused (${ctx.unusedDevices().length})`, () => {
                ctx.forgetUnused()
                rerender()
            })),
            phones.length
                ? h('div', { className: 'list-group mb-3' }, ...phones)
                : h('p', { className: 'text-muted', textContent: 'None yet. Scan the QR on a phone to add one.' }),

            h('h3', { className: 'mt-4 mb-3', textContent: 'Your computers' }),
            h('p', { className: 'text-muted', textContent: `Link once, from either computer, and both can reach each other: ${uses.join('; ')}.` }),
            ...linkRows(seen),
            line('Show this computer on my network', `So your other computers (and a phone signed in to one of them) find this one. Linking still needs its code. ${seen.length ? `Seen now: ${seen.map(p => p.name).join(', ')}.` : 'No other computers seen right now.'}`,
                toggle(store.announce, on => {
                    set('announce', on)
                    ctx.announce()
                })),
            ...computers.length ? [line('Computers that can reach this one', 'Remove one to unlink it both ways.', h('span')), h('div', { className: 'list-group mb-3' }, ...computers)] : [],

            h('h3', { className: 'mt-4 mb-3', textContent: 'Shared folders' }),
            ...folderRows(),

            h('h3', { className: 'mt-4 mb-3', textContent: 'This computer' }),
            name.row,
            line('Fingerprint', 'A computer linking to this one shows it first: check they match.', h('input', { className: 'form-control', style: FIELD, type: 'text', readOnly: true, value: ctx.myFingerprint() })),

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
