const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const http = require('http')
const { pipeline } = require('stream/promises')
const { sha } = require('./secrets')

// rel is ".." or starts "..\" only when outside: a name like "..foo" is inside.
const inside = (root, p) => {
    const rel = path.relative(root, p)
    return rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel)
}

class Refused extends Error {
    constructor (status, code, message) {
        super(message)
        Object.assign(this, { status, code })
    }
}
const refuse = (status, code, message) => { throw new Refused(status, code, message) }

const sendJson = (res, status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
    res.end(JSON.stringify(body))
}

/** /api/prove's answer: HMAC of the nonce and the asker's address (IPv4 written plainly), keyed by the token hash. */
const proofFor = (hash, nonce, address) => crypto.createHmac('sha256', hash).update(`${nonce} ${String(address).replace(/^::ffff:/, '')}`).digest('hex')

// mtime in ms since the epoch; a folder's size is 0.
const entry = (name, st) => ({ name, type: st?.isDirectory() ? 'dir' : 'file', size: st?.isFile() ? st.size : 0, mtime: st ? st.mtimeMs : null })

/**
 * Files between the user's computers: another computer linked to this one (Settings › Send to computer) lists, reads,
 * writes, moves and deletes files here, inside the Shared folders only. Nothing is shared until a folder is added.
 * Every path is resolved to its real path before the check, so `..` and links cannot leave a shared folder.
 */
module.exports = ctx => {
    const { store } = ctx
    store.sharedFolders ??= []

    const roots = async () => (await Promise.all(store.sharedFolders.map(r => fs.promises.realpath(r).catch(() => null)))).filter(Boolean)

    /** The real path of `p`, inside a shared folder. `create`: it may not exist yet; its nearest existing parent is
     *  resolved instead, and the rest appended (path.resolve has already taken out any `..`). */
    async function resolve (p, { create = false, notRoot = false } = {}) {
        // Never a network path: resolving \\host\share would send Windows' NTLM login to that host.
        if (typeof p !== 'string' || !path.isAbsolute(p) || /^[\\/]{2}/.test(p) || p.includes('\0')) refuse(400, 'bad-path', 'an absolute local path is needed')
        const allowed = await roots()
        if (!allowed.length) refuse(403, 'not-shared', 'no folders are shared on this computer')
        let at = path.resolve(p)
        let rest = ''
        let real = null
        while (!(real = await fs.promises.realpath(at).catch(() => null))) {
            if (!create || path.dirname(at) === at) refuse(404, 'missing', 'no such file or folder')
            rest = rest ? path.join(path.basename(at), rest) : path.basename(at)
            at = path.dirname(at)
        }
        const full = rest ? path.join(real, rest) : real
        const root = allowed.find(r => inside(r, full))
        if (!root) refuse(403, 'outside', 'outside the shared folders')
        // Nor one holding a shared folder (shares can sit inside each other).
        if (notRoot && allowed.some(r => inside(full, r))) refuse(403, 'shared-folder', 'a shared folder itself cannot be changed')
        return full
    }

    const exists = p => fs.promises.lstat(p).then(() => true, () => false)

    async function read (req, res, file) {
        const st = await fs.promises.stat(file)
        if (!st.isFile()) refuse(400, 'not-a-file', 'not a file')
        // Range: bytes=N- or N-M, so a broken download can carry on where it stopped.
        const m = st.size ? /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '') : null
        const start = m ? Number(m[1]) : 0
        const end = m && m[2] ? Math.min(Number(m[2]), st.size - 1) : st.size - 1
        if (m && start > end) {
            res.writeHead(416, { 'Content-Range': `bytes */${st.size}` })
            return res.end()
        }
        res.writeHead(m ? 206 : 200, {
            'Content-Type': 'application/octet-stream',
            'Content-Length': st.size ? end - start + 1 : 0,
            'Last-Modified': st.mtime.toUTCString(),
            'Accept-Ranges': 'bytes',
            ...m ? { 'Content-Range': `bytes ${start}-${end}/${st.size}` } : {},
            'Cache-Control': 'no-store',
        })
        if (!st.size) return res.end()
        await pipeline(fs.createReadStream(file, { start, end }), res).catch(() => {})
    }

    /** The body goes to a hidden part file beside the target, renamed into place once all of it arrived; a failed or
     *  broken upload leaves nothing behind. No size limit: it streams to disk. */
    async function write (req, file, overwrite) {
        const st = await fs.promises.stat(path.dirname(file)).catch(() => null)
        if (!st?.isDirectory()) refuse(404, 'no-folder', 'the folder does not exist')
        const check = async () => {
            const there = await fs.promises.lstat(file).catch(() => null)
            if (there?.isDirectory()) refuse(409, 'is-folder', 'a folder has that name')
            if (there && !overwrite) refuse(409, 'exists', 'already exists')
        }
        await check()
        const part = path.join(path.dirname(file), `.${path.basename(file)}.tabby-part-${crypto.randomBytes(4).toString('hex')}`)
        try {
            await pipeline(req, fs.createWriteStream(part, { flags: 'wx' }))
            const expected = Number(req.headers['content-length'])
            const got = (await fs.promises.stat(part)).size
            if (Number.isFinite(expected) && got !== expected) refuse(400, 'incomplete', 'the upload stopped early')
            await check()
            if (overwrite) {
                await fs.promises.rename(part, file)
            } else {
                // A hard link fails when the name was taken meanwhile (two uploads of one name), where rename would
                // replace it; a file system without hard links (FAT) falls back to the check just made.
                const linked = await fs.promises.link(part, file).then(() => true, e => e.code === 'EEXIST' ? refuse(409, 'exists', 'already exists') : false)
                if (linked) await fs.promises.rm(part, { force: true })
                else await fs.promises.rename(part, file)
            }
        } catch (e) {
            await fs.promises.rm(part, { force: true }).catch(() => {})
            throw e
        }
        return entry(path.basename(file), await fs.promises.stat(file))
    }

    async function move (from, to, overwrite) {
        if (await exists(to)) {
            if (!overwrite) refuse(409, 'exists', 'already exists')
            if ((await fs.promises.lstat(to)).isDirectory()) refuse(409, 'is-folder', 'a folder has that name')
        }
        if (inside(from, to)) refuse(400, 'into-itself', 'a folder cannot move into itself')
        try {
            await fs.promises.rename(from, to)
        } catch (e) {
            // Another drive: copied, then the original goes.
            if (e.code !== 'EXDEV') throw e
            await fs.promises.cp(from, to, { recursive: true, force: !!overwrite, errorOnExist: !overwrite })
            await fs.promises.rm(from, { recursive: true, force: true })
        }
    }

    /** /api/files/<op>. phone: a phone or browser (not a linked computer), which only browses, reads and uploads new
     *  files: nothing it does can lose a file. */
    async function handleFiles (req, res, url, op, phone = false) {
        const q = url.searchParams
        if (phone && !['roots', 'list', 'stat', 'read', 'write'].includes(op)) return sendJson(res, 403, { error: 'only a linked computer can change files here', code: 'not-a-computer' })
        const body = async () => {
            const chunks = []
            for await (const c of req) {
                chunks.push(c)
                if (chunks.reduce((n, x) => n + x.length, 0) > 65536) refuse(413, 'too-large', 'body too large')
            }
            let b = null
            try {
                b = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
            } catch { }
            if (!b || typeof b !== 'object' || Array.isArray(b)) refuse(400, 'bad-body', 'a JSON object is needed')
            return b
        }
        // Copying, moving or trashing a big folder can go quiet for longer than the minute a request may (routes.js).
        if (['copy', 'move', 'delete', 'mkdir'].includes(op)) req.setTimeout(0)
        try {
            if (req.method === 'GET' && op === 'roots') {
                // Each named after its folder, unique on this computer: "Docs", "Docs (2)".
                const taken = new Map()
                return sendJson(res, 200, (await roots()).map(r => {
                    const base = path.basename(r) || r.replace(/[\\/:]+$/, '')
                    const n = (taken.get(base.toLowerCase()) ?? 0) + 1
                    taken.set(base.toLowerCase(), n)
                    return { name: n > 1 ? `${base} (${n})` : base, path: r }
                }))
            }
            if (req.method === 'GET' && op === 'list') {
                const dir = await resolve(q.get('path'))
                const names = await fs.promises.readdir(dir).catch(e => e.code === 'ENOTDIR' ? refuse(400, 'not-a-folder', 'not a folder') : refuse(404, 'missing', 'no such folder'))
                return sendJson(res, 200, await Promise.all(names.map(async n => entry(n, await fs.promises.stat(path.join(dir, n)).catch(() => null)))))
            }
            if (req.method === 'GET' && op === 'stat') {
                const p = await resolve(q.get('path'))
                return sendJson(res, 200, entry(path.basename(p), await fs.promises.stat(p)))
            }
            if (req.method === 'GET' && op === 'read') return await read(req, res, await resolve(q.get('path')))
            if (req.method === 'PUT' && op === 'write') {
                const file = await resolve(q.get('path'), { create: true, notRoot: true })
                return sendJson(res, 200, await write(req, file, !phone && q.get('overwrite') === '1'))
            }
            if (req.method === 'POST' && op === 'mkdir') {
                const dir = await resolve((await body()).path, { create: true })
                const there = await fs.promises.stat(dir).catch(() => null)
                if (there && !there.isDirectory()) refuse(409, 'exists', 'a file has that name')
                await fs.promises.mkdir(dir, { recursive: true })
                return sendJson(res, 200, {})
            }
            if (req.method === 'POST' && op === 'move') {
                const b = await body()
                const from = await resolve(b.from, { notRoot: true })
                const to = await resolve(b.to, { create: true, notRoot: true })
                // The same file in another case (foo.txt → Foo.txt, Windows and macOS): a rename to the new spelling.
                if (path.relative(from, to) === '') await fs.promises.rename(from, path.join(path.dirname(from), path.basename(path.resolve(b.to))))
                else await move(from, to, !!b.overwrite)
                return sendJson(res, 200, {})
            }
            if (req.method === 'POST' && op === 'copy') {
                // On this computer, so a copy inside it never goes over the network.
                const b = await body()
                const from = await resolve(b.from)
                const to = await resolve(b.to, { create: true, notRoot: true })
                if (await exists(to)) refuse(409, 'exists', 'already exists')
                if (inside(from, to)) refuse(400, 'into-itself', 'a folder cannot be copied into itself')
                await fs.promises.cp(from, to, { recursive: true, errorOnExist: true, force: false })
                return sendJson(res, 200, {})
            }
            if (req.method === 'POST' && op === 'delete') {
                const b = await body()
                const p = await resolve(b.path, { notRoot: true })
                // A transfer's own unfinished part (.<name>.tabby-part-<id>) is removed outright, and nothing else is:
                // everything else goes to the Recycle Bin / Trash.
                if (b.part === true) {
                    if (!/^\..+\.tabby-part-[^\\/]+$/.test(path.basename(p))) refuse(400, 'not-a-part', 'only a .tabby-part- file or folder can be removed outright')
                    await fs.promises.rm(p, { recursive: true, force: true })
                } else {
                    // Through the main process: in Tabby's window, Windows cannot start the Recycle Bin operation.
                    await require('@electron/remote').shell.trashItem(p)
                }
                return sendJson(res, 200, {})
            }
            sendJson(res, 404, { error: 'not found', code: 'no-such-op' })
        } catch (e) {
            if (res.headersSent) return res.destroy()
            if (e instanceof Refused) return sendJson(res, e.status, { error: e.message, code: e.code })
            if (e.code === 'ERR_FS_CP_EEXIST' || e.code === 'EEXIST') return sendJson(res, 409, { error: 'already exists', code: 'exists' })
            if (e.code === 'ENOENT') return sendJson(res, 404, { error: 'no such file or folder', code: 'missing' })
            if (e.code === 'EACCES' || e.code === 'EPERM' || e.code === 'EBUSY') return sendJson(res, 409, { error: e.message, code: 'denied' })
            throw e
        }
    }

    /** Settings: adds a folder to share (its real path), or says why not. */
    async function shareFolder (p) {
        p = String(p ?? '').trim().replace(/^"(.*)"$/, '$1')
        if (!path.isAbsolute(p) || /^[\\/]{2}/.test(p)) return 'Type a full local path, like C:\\Users\\you\\Documents'
        const real = await fs.promises.realpath(p).catch(() => null)
        if (!real || !(await fs.promises.stat(real)).isDirectory()) return 'No such folder'
        if (!store.sharedFolders.includes(real)) store.sharedFolders.push(real)
        ctx.save()
        return null
    }
    const unshareFolder = p => {
        store.sharedFolders = store.sharedFolders.filter(r => r !== p)
        ctx.save()
    }

    // ---- This computer's side: the files of the computers it is linked to (for the Files tab, in-process) ----

    /** Where a linked computer answers: its address on this network when heard lately, else its Tailscale name. */
    const addressOf = id => {
        const l = store.links?.[id]
        return ctx.otherComputers().find(c => c.computerId === id)?.url ?? (l?.tailscale && l.port ? `http://${l.tailscale}:${l.port}/` : null)
    }

    /** A small JSON request there, in 3 s at most; null when it does not answer. `local`: this end's address. */
    const small = (base, p, body, local = {}) => new Promise(resolve => {
        const data = body && Buffer.from(JSON.stringify(body))
        const req = http.request(new URL(p, base), { method: body ? 'POST' : 'GET', timeout: 3000, headers: data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {} }, res => {
            local.address = res.socket?.localAddress
            let text = ''
            res.on('data', c => { text += c })
            res.on('end', () => {
                try {
                    resolve(res.statusCode === 200 ? JSON.parse(text) : null)
                } catch {
                    resolve(null)
                }
            })
        })
        req.on('error', () => resolve(null))
        req.on('timeout', () => req.destroy())
        req.end(data)
    })

    /**
     * Whether the computer at `base` is really the linked one, before its token is sent there: announcements on the
     * network prove nothing (anyone can announce a computer's id). It proves it holds this link's token hash, for
     * this question as it saw it come from this computer's address (POST /api/prove), so a host that announced
     * itself and passed the question on to the real one fails. Remembered for 10 minutes per address.
     * ponytail: a host that can also fake its address (in the middle of the connection) could still pass, as it could
     * read plain HTTP anyway (Tailscale encrypts; a home network is trusted, as for phones).
     */
    const proven = new Map()
    async function verified (id, base, l = store.links?.[id]) {
        const key = `${id} ${base}`
        if (!l || !base) return false
        if (Date.now() - (proven.get(key) ?? 0) < 600000) return true
        const nonce = crypto.randomBytes(32).toString('hex')
        const local = {}
        const r = await small(base, 'api/prove', { deviceId: l.deviceId, nonce }, local)
        const ok = typeof r?.proof === 'string' && !!local.address && r.proof === proofFor(sha(l.token).toString('hex'), nonce, local.address)
        if (ok) proven.set(key, Date.now())
        return ok
    }

    /** The linked computers, named safely for a URL scheme (letters, digits, - and _), and whether each answers now.
     *  Each one's Tailscale name and port are remembered, so it is still found away from this network. */
    async function computers () {
        return Promise.all(Object.entries(store.links ?? {}).map(async ([id, l]) => {
            const base = addressOf(id)
            const i = await verified(id, base) && await small(base, 'api/info')
            if (i?.id === id && (i.tailscale !== l.tailscale || i.port !== l.port)) {
                Object.assign(l, { tailscale: i.tailscale ?? null, port: i.port })
                ctx.save()
            }
            return { id, name: l.name.replace(/[^A-Za-z0-9_-]/g, '-'), online: i?.id === id }
        }))
    }

    const OFFLINE = new Set(['ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET'])

    /**
     * One file operation on a linked computer (/api/files/<op> there, with this computer's token for it): resolves
     * with the answer (an http.IncomingMessage, whatever its status), and rejects only when it cannot be reached
     * (code 'offline') or is aborted. `body`: a Readable or Buffer as is, anything else as JSON.
     */
    async function fetchFiles (id, op, { query = {}, method, body, signal, headers = {} } = {}) {
        const stream = body != null && typeof body.pipe === 'function' ? body : null
        const aborted = () => Object.assign(new Error('aborted'), { name: 'AbortError', code: 'ABORT_ERR' })
        // A body stream that is never sent is closed, so its file is not left open.
        const fail = e => {
            stream?.destroy()
            throw e
        }
        const l = store.links?.[id]
        const base = l && addressOf(id)
        if (!base) fail(Object.assign(new Error(l ? `${l.name} is not reachable` : 'not a linked computer'), { code: l ? 'offline' : 'unknown' }))
        // Not what answers there (an old version, or something else announcing that computer): its token is not sent.
        if (!await verified(id, base)) fail(Object.assign(new Error(`${l.name} did not answer as itself`), { code: 'unverified' }))
        if (signal?.aborted) fail(aborted())
        const url = new URL(`api/files/${encodeURIComponent(op)}`, base)
        for (const [k, v] of Object.entries(query)) url.searchParams.set(k, String(v))
        const data = body == null || stream || Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body))
        return new Promise((resolve, reject) => {
            const req = http.request(url, {
                method: method ?? (body == null ? 'GET' : op === 'write' ? 'PUT' : 'POST'),
                headers: { Authorization: `Bearer ${l.token}`, ...data !== body ? { 'Content-Type': 'application/json' } : {}, ...Buffer.isBuffer(data) ? { 'Content-Length': data.length } : {}, ...headers },
            }, res => {
                at = res
                res.on('close', () => signal?.removeEventListener('abort', abort))
                resolve(res)
            })
            // The window's AbortSignal is not Node's (Node's streams refuse it), so it is followed here: aborting breaks
            // the connection (the other computer drops what it had written), or stops the answer streaming in, which
            // then ends with an error.
            let at = req
            const abort = () => at.destroy(aborted())
            signal?.addEventListener('abort', abort, { once: true })
            req.on('error', e => {
                signal?.removeEventListener('abort', abort)
                stream?.destroy()
                reject(OFFLINE.has(e.code) ? Object.assign(new Error(`${l.name} is not reachable`), { code: 'offline', cause: e }) : e)
            })
            if (!stream) req.end(data ?? undefined)
            else stream.on('error', e => req.destroy(e)).pipe(req)
        })
    }

    return { handleFiles, shareFolder, unshareFolder, proofFor, verifiedPeer: verified, filesApi: { computers, fetch: fetchFiles } }
}
