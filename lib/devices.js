const crypto = require('crypto')
const { sha, passwordMatches } = require('./secrets')

const DAY = 86400000

/** Paired devices: their tokens, sign-in lockouts, and forgetting the unused ones. */
module.exports = ctx => {
    const { store, clients, eventClients } = ctx
    const fails = new Map()

    function deviceFor (token) {
        if (!token) return null
        const h = sha(token).toString('hex')
        const device = store.devices.find(d => d.hash === h) ?? null
        // Saved at most once a minute per device.
        if (device && Date.now() - (device.lastSeen ?? 0) > 60000) {
            device.lastSeen = Date.now()
            ctx.save()
        }
        return device
    }

    const passwordOk = pw => passwordMatches(store.passwordHash, pw)

    // Five wrong tries in a minute lock that address out for a minute.
    const locked = addr => (fails.get(addr)?.until ?? 0) > Date.now()
    function fail (addr) {
        const now = Date.now()
        const f = fails.get(addr) ?? { times: [], until: 0 }
        f.times = f.times.filter(t => now - t < 60000).concat(now)
        if (f.times.length >= 5) {
            f.until = now + 60000
            f.times = []
        }
        fails.set(addr, f)
    }

    /** `computer`: a linked computer (Send to computer), which may also send it Claude sessions. */
    function newDevice (name, computer = false) {
        const token = crypto.randomBytes(32).toString('base64url')
        const device = { id: crypto.randomBytes(8).toString('hex'), name: String(name || 'Device').slice(0, 64), color: ctx.freeColor(), hash: sha(token).toString('hex'), created: new Date().toISOString(), ...computer ? { computer: true } : {} }
        store.devices.push(device)
        ctx.save()
        return { token, deviceId: device.id }
    }

    /** Unpairs a device: its token stops working, and its open connections close (its page shows sign-in). */
    function removeDevice (gone) {
        store.devices = store.devices.filter(d => d !== gone)
        ctx.save()
        for (const c of [...clients, ...eventClients]) {
            if (c.device.id === gone.id) c.conn.close(4001)
        }
        // A linked computer leaving (it unlinked, or was removed here) ends the link this way too: one link, both ways.
        if (gone.computerId && store.links?.[gone.computerId]) ctx.unlink(gone.computerId)
    }

    const connectedIds = () => new Set([...clients, ...eventClients].map(c => c.device.id))

    /**
     * The devices to forget (a private browser tab pairs a new device every time): not connected now, and either not
     * seen for `days`, or paired over a day ago and never used after the visit they paired in.
     */
    function unusedDevices (days = store.forgetDays) {
        const live = connectedIds()
        const now = Date.now()
        return store.devices.filter(d => {
            // A linked computer may go unused for weeks; it is unlinked by hand (Settings › Devices › Your computers).
            if (live.has(d.id) || d.computer) return false
            const created = Date.parse(d.created) || 0
            const seen = d.lastSeen ?? created
            const firstVisitOnly = seen - created < 15 * 60000 && now - created > DAY
            return now - seen > days * DAY || firstVisitOnly
        })
    }

    function forgetUnused (days) {
        const gone = unusedDevices(days)
        gone.forEach(removeDevice)
        return gone.length
    }

    const forgetTimer = setInterval(() => store.autoForget && forgetUnused(), 6 * 3600000)
    const forgetSoon = setTimeout(() => store.autoForget && forgetUnused(), 60000)

    ctx.cleanup.push(() => {
        clearInterval(forgetTimer)
        clearTimeout(forgetSoon)
    })
    return { deviceFor, passwordOk, locked, fail, newDevice, removeDevice, connectedIds, unusedDevices, forgetUnused }
}
