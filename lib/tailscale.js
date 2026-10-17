const fs = require('fs')
const { tailscaleAddress } = require('./net')

// Where the CLI is: on PATH, else the default install (Windows), Homebrew, or inside the Mac app.
const CLI = process.platform === 'win32'
    ? ['tailscale', 'C:\\Program Files\\Tailscale\\tailscale.exe']
    : ['tailscale', '/opt/homebrew/bin/tailscale', '/usr/local/bin/tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale']

const status = cmd => new Promise(resolve => {
    if (/[\\/]/.test(cmd) && !fs.existsSync(cmd)) return resolve(null)
    require('child_process').execFile(cmd, ['status', '--json'], { timeout: 3000, windowsHide: true }, (err, out) => resolve(err ? null : out))
})

/** This computer on Tailscale: its MagicDNS name from the CLI (`Self.DNSName`), else its 100.x address. */
module.exports = () => {
    let cache = { at: 0, name: null }

    async function magicDnsName () {
        if (Date.now() - cache.at < 60000) return cache.name
        let name = null
        for (const cmd of CLI) {
            const out = await status(cmd)
            if (!out) continue
            try {
                name = JSON.parse(out).Self?.DNSName?.replace(/\.$/, '').toLowerCase() || null
            } catch { }
            break
        }
        cache = { at: Date.now(), name }
        return name
    }

    /** The host a phone on Tailscale opens, or null without Tailscale. */
    async function tailscaleHost () {
        const ip = tailscaleAddress()
        return ip && ((await magicDnsName()) ?? ip)
    }

    return { tailscaleHost, tailscaleName: () => cache.name }
}
