const os = require('os')
const dgram = require('dgram')
const { phoneAddress } = require('./net')

const ANNOUNCE_PORT = 41681

// An announced name is anyone's to choose, and shows in Settings and in the link question: one plain line, without
// control, format (bidi, zero-width) or separator characters, quotes, or anything shaped like a fingerprint.
const plainName = s => String(s ?? '').replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}"]/gu, ' ').replace(/[A-Z0-9]{4}(-[A-Z0-9]{4}){2,}/gi, '…').replace(/\s+/g, ' ').trim().slice(0, 40)

/**
 * Other computers: each Tabby announces itself on the local network every 30 s, { app, v, computerId, name, port },
 * and hears the others. Nothing secret: signing in to another computer still needs its own code or password. Where a
 * firewall blocks it, it fails quietly and the phone's list of computers is just empty.
 */
module.exports = ctx => {
    const { store } = ctx
    const peers = new Map()
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true })
    socket.on('error', e => console.warn('[tabby-remote] announce', e.message))
    socket.on('message', (buf, from) => {
        let m
        try {
            m = JSON.parse(buf.toString('utf8'))
        } catch {
            return
        }
        if (m?.app !== 'tabby-remote' || m.v !== 1 || typeof m.computerId !== 'string' || m.computerId === store.computerId) return
        if (!Number.isInteger(m.port) || m.port < 1 || m.port > 65535) return
        // Its address is the one the message came from: an IP change is followed on the next announcement.
        peers.set(m.computerId, { computerId: m.computerId, name: plainName(m.name) || from.address, url: `http://${from.address}:${m.port}/`, seen: Date.now() })
    })

    /** The broadcast address (from its netmask) of the network phones use (see phoneAddress), only: not a virtual one
     *  (Hyper-V, WSL, VPN), whose address another computer could not reach. */
    const broadcastAddresses = () => Object.values(os.networkInterfaces()).flat()
        .filter(a => a.family === 'IPv4' && !a.internal && a.address === phoneAddress())
        .map(a => a.address.split('.').map((o, i) => (Number(o) | (~Number(a.netmask.split('.')[i]) & 255)) & 255).join('.'))

    function announce () {
        if (!store.announce || !store.enabled || !ctx.listening()) return
        const msg = Buffer.from(JSON.stringify({ app: 'tabby-remote', v: 1, computerId: store.computerId, name: ctx.computerName(), port: ctx.listeningPort }))
        for (const to of broadcastAddresses()) socket.send(msg, ANNOUNCE_PORT, to, () => {})
    }

    socket.bind(ANNOUNCE_PORT, () => {
        try {
            socket.setBroadcast(true)
        } catch { }
        announce()
    })
    const timer = setInterval(announce, 30000)

    /** The other computers heard from in the last 2 minutes. */
    const otherComputers = () => [...peers.values()].filter(p => Date.now() - p.seen < 120000).map(({ seen, ...p }) => p)

    ctx.cleanup.push(() => {
        clearInterval(timer)
        try {
            socket.close()
        } catch { }
    })
    return { announce, otherComputers }
}
