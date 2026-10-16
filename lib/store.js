const fs = require('fs')
const crypto = require('crypto')
const { hashPassword } = require('./secrets')

// Not 7680: Windows Delivery Optimization holds that port on every PC.
const defaults = () => ({ enabled: true, name: null, port: 7681, passwordHash: null, devices: [], keepAwake: true, keepScreen: false, awakeMinutes: 30, announce: true, autoForget: true, forgetDays: 30 })

/** Settings (Tabby's Settings > Phone access) and paired devices, kept outside Tabby's config, which syncs between computers. */
function loadStore (file) {
    let store = defaults()
    try {
        store = { ...store, ...JSON.parse(fs.readFileSync(file, 'utf8')) }
    } catch { }
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
    if (changed) write()
    return { store, write }
}

module.exports = { loadStore }
