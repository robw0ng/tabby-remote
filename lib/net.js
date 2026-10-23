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

// Adapters a phone cannot reach: virtual machines and containers (WSL and Hyper-V's vEthernet, VMware, VirtualBox,
// Docker, a Mac's bridge100), tunnels and VPNs (Tailscale gets its own QR).
const VIRTUAL = /vethernet|wsl|hyper-v|vmware|virtualbox|vbox|docker|^br-|bridge|virbr|veth|utun|^tun|^tap|zerotier|tailscale|wireguard|vpn|npcap/i

/** The address a phone on the same Wi-Fi can reach: a real adapter's (Wi-Fi, Ethernet), 192.168.x first, then 10.x,
 *  then 172.16–31.x; a virtual adapter's only when there is nothing else. */
function phoneAddress (interfaces = os.networkInterfaces()) {
    const usable = virtual => Object.entries(interfaces)
        .filter(([name]) => VIRTUAL.test(name) === virtual)
        .flatMap(([, list]) => list)
        .filter(a => a.family === 'IPv4' && !a.internal && PRIVATE.test(a.address))
        .map(a => a.address)
    const pick = a => a.find(x => x.startsWith('192.168.')) ?? a.find(x => x.startsWith('10.')) ?? a[0]
    return pick(usable(false)) ?? pick(usable(true)) ?? tailscaleAddress() ?? '127.0.0.1'
}

/** This computer's Tailscale address, or null without Tailscale. */
const tailscaleAddress = () => lanAddresses().find(a => TAILSCALE.test(a)) ?? null

module.exports = { lanAddresses, phoneAddress, tailscaleAddress }
