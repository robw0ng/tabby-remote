const os = require('os')

const PRIVATE = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/
// 100.64.0.0/10: Tailscale's addresses, to reach this computer away from home.
const TAILSCALE = /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./

/** IPv4 loopback, private (RFC 1918) and Tailscale addresses; never 0.0.0.0. */
function lanAddresses () {
    return Object.values(os.networkInterfaces()).flat()
        .filter(a => a.family === 'IPv4' && (a.internal || PRIVATE.test(a.address) || TAILSCALE.test(a.address)))
        .map(a => a.address)
}

/** The address a phone on the same Wi-Fi can reach: 192.168.x first, then 10.x, then 172.16–31.x, then Tailscale's. */
function phoneAddress () {
    const a = lanAddresses().filter(x => x !== '127.0.0.1')
    return a.find(x => x.startsWith('192.168.')) ?? a.find(x => x.startsWith('10.')) ?? a.find(x => PRIVATE.test(x)) ?? a[0] ?? '127.0.0.1'
}

module.exports = { lanAddresses, phoneAddress }
