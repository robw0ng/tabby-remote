const fs = require('fs')
const crypto = require('crypto')
const { hashPassword } = require('./secrets')

// Not 7680: Windows Delivery Optimization holds that port on every PC.
const defaults = () => ({ enabled: true, name: null, port: 7681, passwordHash: null, devices: [], keepAwake: true, keepScreen: false, awakeMinutes: 30, announce: true, autoForget: true, forgetDays: 30 })

/** Settings (Tabby's Settings > Devices) and paired devices, kept outside Tabby's config, which syncs between computers. */
function loadStore (file) {
    let store = defaults()
    let text = null
    try {
        text = fs.readFileSync(file, 'utf8')
    } catch { }
    if (text !== null) {
        try {
            // A BOM: the file was saved by hand, in an editor that adds one.
            store = { ...store, ...JSON.parse(text.replace(/^﻿/, '')) }
        } catch {
            // Unreadable: kept aside, so its paired devices are not overwritten with a fresh file.
            fs.renameSync(file, `${file}.unreadable-${Date.now()}`)
            console.warn('[tabby-remote] could not read', file, '; kept it as .unreadable and started fresh')
        }
    }
    const write = () => fs.writeFileSync(file, JSON.stringify(store, null, 2))

    let changed = false
    // A permanent id, so a client that knows several computers recognises this one at a new address.
    if (!store.computerId) {
        store.computerId = crypto.randomBytes(8).toString('hex')
        changed = true
    }
    // Devices paired before "last seen" existed count from now, so none is forgotten as "used only once".
    if (store.devices.some(d => !d.lastSeen)) {
        store.devices.forEach(d => { d.lastSeen ??= Date.now() })
        changed = true
    }
    // An older version kept the password in plain text.
    if (store.password) {
        store.passwordHash = hashPassword(store.password)
        delete store.password
        changed = true
    }
    // The old /api/fs folders (fsRoots, only listed, only to phones) are not carried over: Shared folders give phones
    // reading and linked computers changes too, which nobody agreed to for them. Share them again in Settings.
    if (store.fsRoots) {
        delete store.fsRoots
        changed = true
    }
    if (changed) write()
    return { store, write }
}

module.exports = { loadStore }
