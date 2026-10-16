const os = require('os')

/** IPv4 loopback and private (RFC 1918) addresses; never 0.0.0.0. */
function lanAddresses () {
    return Object.values(os.networkInterfaces()).flat()
        .filter(a => a.family === 'IPv4' && (a.internal || /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address)))
        .map(a => a.address)
}

/** The address a phone on the same Wi-Fi can reach: 192.168.x first, then 10.x, then 172.16–31.x. */
function phoneAddress () {
    const a = lanAddresses().filter(x => x !== '127.0.0.1')
    return a.find(x => x.startsWith('192.168.')) ?? a.find(x => x.startsWith('10.')) ?? a[0] ?? '127.0.0.1'
}

module.exports = { lanAddresses, phoneAddress }
