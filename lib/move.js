const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')

const MAX_SESSION = 200 << 20
const configDir = () => process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')

/** claude-sessions' scripts folder (it has session-export.mjs and session-import.mjs), or null when not installed. */
function sessionScripts () {
    if (!nodeBin()) return null
    try {
        const installed = JSON.parse(fs.readFileSync(path.join(configDir(), 'plugins', 'installed_plugins.json'), 'utf8'))
        for (const [key, installs] of Object.entries(installed.plugins ?? {})) {
            if (!key.startsWith('claude-sessions@')) continue
            for (const i of installs) {
                const dir = path.join(i.installPath, 'scripts')
                if (fs.existsSync(path.join(dir, 'session-export.mjs')) && fs.existsSync(path.join(dir, 'session-import.mjs'))) return dir
            }
        }
    } catch { }
    return null
}

// Node for claude-sessions' scripts (Tabby's own binary cannot run as Node): on PATH, else the usual installs.
const NODES = process.platform === 'win32'
    ? ['node', path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'nodejs', 'node.exe')]
    : ['node', '/opt/homebrew/bin/node', '/usr/local/bin/node']
let nodeFound
function nodeBin () {
    if (nodeFound !== undefined) return nodeFound
    nodeFound = NODES.find(n => require('child_process').spawnSync(n, ['--version'], { windowsHide: true, timeout: 10000 }).status === 0) ?? null
    return nodeFound
}

/** Runs a claude-sessions script and returns the JSON line it prints. */
function runScript (script, args) {
    return new Promise(resolve => {
        require('child_process').execFile(nodeBin(), [script, ...args], {
            timeout: 120000,
            maxBuffer: 1 << 20,
            windowsHide: true,
        }, (err, stdout) => {
            const line = String(stdout ?? '').trim().split('\n').at(-1)
            try {
                resolve(JSON.parse(line))
            } catch {
                resolve({ ok: false, error: err?.message ?? 'no answer from claude-sessions' })
            }
        })
    })
}

// The system's bsdtar, which reads zips: Windows' own (Git's GNU tar cannot), macOS's.
const BSDTAR = process.platform === 'win32' ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar'

/** The zip's entries, without a leading ./; null when it cannot be listed. */
function zipEntries (file) {
    return new Promise(resolve => {
        require('child_process').execFile(BSDTAR, ['-tf', file], { timeout: 30000, windowsHide: true, maxBuffer: 8 << 20 }, (err, out) => resolve(err ? null : out.split(/\r?\n/).map(e => e.replace(/^\.\//, '')).filter(Boolean)))
    })
}

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Whether the zip holds only what an export makes: meta.json, <id>.jsonl and files under <id>/; no other names,
 *  no absolute paths, no `..`. */
function zipLooksRight (entries) {
    const jsonl = entries.filter(e => /^[^/\\]+\.jsonl$/.test(e))
    const id = jsonl.length === 1 && jsonl[0].slice(0, -6)
    if (!id || !SESSION_ID.test(id) || !entries.includes('meta.json')) return false
    return entries.every(e => !e.includes('\\') && !e.split('/').includes('..') && !/^([a-z]:|\/)/i.test(e)
        && (e === 'meta.json' || e === `${id}.jsonl` || e.startsWith(`${id}/`)))
}

/** An HTTP request with Node's own client (Tabby's window fetch would send an Origin the other computer refuses). */
function request (url, { method = 'GET', headers = {}, body, file } = {}) {
    return new Promise(resolve => {
        const req = http.request(url, { method, headers: { ...headers, ...file ? { 'Content-Length': fs.statSync(file).size } : {} }, timeout: 300000 }, res => {
            let text = ''
            res.setEncoding('utf8')
            res.on('data', c => { text += c })
            res.on('end', () => {
                let json = null
                try {
                    json = JSON.parse(text)
                } catch { }
                resolve({ status: res.statusCode, json })
            })
        })
        req.on('error', e => resolve({ status: 0, json: { error: e.message } }))
        req.on('timeout', () => req.destroy(new Error('timed out')))
        if (file) fs.createReadStream(file).pipe(req)
        else req.end(body)
    })
}

/**
 * Send to computer: a Claude chat moves from a tab here to a new tab on another of the user's computers, through
 * claude-sessions' export and import. Computers trust each other by linking once: this one signs in to the other
 * (its password, or the code from its QR) and keeps the token, as a phone would; the other marks it a computer.
 */
module.exports = ctx => {
    const { store, notifications } = ctx
    store.links ??= {}

    /** The computers this one can send to: the others seen on the network, and whether each is linked. */
    const targets = () => ctx.otherComputers().map(c => ({ ...c, linked: !!store.links[c.computerId] }))

    async function link (computerId, secret) {
        const target = ctx.otherComputers().find(c => c.computerId === computerId)
        if (!target) return { ok: false, error: 'That computer is not on the network now' }
        const code = /^\d{6}$/.test(secret.trim())
        const r = await request(new URL(code ? 'api/pair' : 'api/login', target.url), {
            method: 'POST',
            body: JSON.stringify({ [code ? 'code' : 'password']: code ? secret.trim() : secret, deviceName: `${ctx.computerName()} (computer)`, computer: true }),
        })
        if (r.status !== 200 || !r.json?.token) return { ok: false, error: r.json?.error ?? `${target.name} answered ${r.status}` }
        if (store.links[computerId]) await unlink(computerId)
        store.links[computerId] = { token: r.json.token, deviceId: r.json.deviceId, name: target.name }
        ctx.save()
        return { ok: true }
    }

    /** Forgets the link here, and removes this computer from the other one's paired devices when it is reachable. */
    async function unlink (computerId) {
        const l = store.links[computerId]
        delete store.links[computerId]
        ctx.save()
        const target = ctx.otherComputers().find(c => c.computerId === computerId)
        if (l?.deviceId && target) await request(new URL(`api/devices/${l.deviceId}`, target.url), { method: 'DELETE', headers: { Authorization: `Bearer ${l.token}` } })
    }

    /** The Claude session in a tab: its focused pane's (tabby-groups reads it from Claude's own files). */
    const claudeSessionOf = tab => {
        const pane = tab.focusedTab ?? ctx.panesOf(tab)[0]
        return pane?.__tgInfo?.kind === 'claude' ? pane.__tgInfo.sessionId ?? null : null
    }

    async function send (tab, computerId) {
        const scripts = sessionScripts()
        if (!scripts) return { ok: false, error: 'Send to computer needs the claude-sessions plugin' }
        const sessionId = claudeSessionOf(tab)
        if (!sessionId) return { ok: false, error: 'No Claude session in that tab' }
        const target = ctx.otherComputers().find(c => c.computerId === computerId)
        const linkTo = store.links[computerId]
        if (!target) return { ok: false, error: 'That computer is not on the network now' }
        if (!linkTo) return { ok: false, error: `Link ${target.name} first (Settings > Phone access)` }

        const out = await runScript(path.join(scripts, 'session-export.mjs'), [sessionId])
        if (!out.ok) return { ok: false, error: `Export: ${out.error}` }
        try {
            const r = await request(new URL('api/import', target.url), { method: 'POST', headers: { Authorization: `Bearer ${linkTo.token}`, 'Content-Type': 'application/zip' }, file: out.zip })
            if (r.status === 401) {
                // Removed on the other side: the link no longer works.
                unlink(computerId)
                return { ok: false, error: `${target.name} no longer knows this computer: link it again` }
            }
            if (r.status !== 200) return { ok: false, error: r.json?.error ?? `${target.name} answered ${r.status}`, warnings: r.json?.warnings ?? [] }
            return { ok: true, name: target.name, cwd: r.json.cwd, warnings: r.json.warnings ?? [] }
        } finally {
            fs.promises.rm(out.zip, { force: true }).catch(() => {})
        }
    }

    /** Sends and says how it went in Tabby, for the tab menu. */
    async function sendWithNotice (tab, computerId) {
        notifications.notice('Sending the Claude chat…')
        const r = await send(tab, computerId)
        if (r.ok) notifications.notice(`Opened on ${r.name}, in ${r.cwd}`)
        else notifications.error(`Not sent: ${r.error}`)
        for (const w of r.warnings ?? []) notifications.notice(w)
        return r
    }

    /** Receiving (POST /api/import from a linked computer): the zip is untrusted. It is checked, imported by
     *  claude-sessions, and only the import's own answer opens the tab. */
    async function receive (req, from) {
        const scripts = sessionScripts()
        if (!scripts) return { status: 501, body: { error: `${ctx.computerName()} needs the claude-sessions plugin` } }
        const file = await ctx.saveUpload(req, 'claude-session.zip', MAX_SESSION)
        if (!file) return { status: 413, body: { error: 'too large or failed' } }
        try {
            const entries = await zipEntries(file)
            if (!entries || !zipLooksRight(entries)) return { status: 400, body: { error: 'not a Claude session export' } }
            const out = await runScript(path.join(scripts, 'session-import.mjs'), [file])
            if (!out.ok) {
                const error = out.needsCwd ? `No clone of ${out.remote} on ${ctx.computerName()}: clone it there, then send again` : out.error
                return { status: 409, body: { error, warnings: out.warnings ?? [] } }
            }
            const cwd = typeof out.cwd === 'string' && path.isAbsolute(out.cwd) && fs.statSync(out.cwd, { throwIfNoEntry: false })?.isDirectory() ? out.cwd : null
            if (!cwd || !SESSION_ID.test(out.sessionId ?? '')) return { status: 500, body: { error: 'claude-sessions gave no usable folder or session' } }
            await ctx.openSession({ cwd, run: `claude --resume ${out.sessionId}` })
            const warnings = (out.warnings ?? []).map(String)
            notifications.notice(`Claude chat from ${from.name.replace(/ \(computer\)$/, '')} opened in ${cwd}`)
            warnings.forEach(w => notifications.notice(w))
            return { status: 200, body: { ok: true, cwd, warnings } }
        } finally {
            fs.promises.rm(file, { force: true }).catch(() => {})
        }
    }

    return { canMove: () => !!sessionScripts(), moveTargets: targets, link, unlink, claudeSessionOf, sendSession: send, sendWithNotice, receive }
}
