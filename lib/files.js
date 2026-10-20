const fs = require('fs')
const os = require('os')
const path = require('path')

const MAX_UPLOAD = 50 << 20
// Files stay in the OS temp folder; clear tabby-remote/uploads there if it ever grows.
const UPLOADS = path.join(os.tmpdir(), 'tabby-remote', 'uploads')

const inside = (root, p) => {
    const rel = path.relative(root, p)
    return !rel.startsWith('..') && !path.isAbsolute(rel)
}

/** Files for the API: browsing the allowed folders, uploads from a device, and this computer's clipboard. */
module.exports = ctx => {
    async function listDir (p) {
        const roots = await Promise.all((ctx.store.fsRoots ?? []).map(r => fs.promises.realpath(r).catch(() => null)))
        const allowed = roots.filter(Boolean)
        if (!p) return allowed.map(r => ({ name: r, type: 'dir', size: 0, mtime: null }))
        // Touch nothing when files are off, and never a network path: resolving \\host\share would send
        // Windows' NTLM login to that host.
        if (!allowed.length || /^[\\/]{2}/.test(p)) return null
        // realpath resolves `..` and links before the check, so neither can leave a root.
        const real = await fs.promises.realpath(path.resolve(p)).catch(() => null)
        if (!real || !allowed.some(r => inside(r, real))) return null
        const entries = await fs.promises.readdir(real, { withFileTypes: true })
        return Promise.all(entries.map(async e => {
            const st = await fs.promises.stat(path.join(real, e.name)).catch(() => null)
            return { name: e.name, type: st?.isDirectory() ? 'dir' : 'file', size: st?.size ?? 0, mtime: st?.mtime.toISOString() ?? null }
        }))
    }

    /** Saves a request body as a file in the uploads folder; its path, or null when too large or failed. */
    async function saveUpload (req, name, max = MAX_UPLOAD) {
        await fs.promises.mkdir(UPLOADS, { recursive: true })
        const file = path.join(UPLOADS, `${Date.now()}-${name}`)
        const ok = await new Promise(resolve => {
            let size = 0
            const out = fs.createWriteStream(file)
            req.on('data', c => {
                size += c.length
                if (size > max) {
                    req.destroy()
                    out.destroy()
                    fs.promises.rm(file, { force: true })
                    resolve(false)
                }
            })
            req.pipe(out)
            out.on('finish', () => resolve(true))
            out.on('error', () => resolve(false))
        })
        return ok ? file : null
    }

    /** The clipboard's text, or an image on it saved to the uploads folder (pasted on the device as a path). */
    async function readClipboard () {
        const { clipboard } = require('electron')
        const image = clipboard.readImage()
        if (image.isEmpty()) return { text: clipboard.readText(), path: null }
        await fs.promises.mkdir(UPLOADS, { recursive: true })
        const file = path.join(UPLOADS, `${Date.now()}-clipboard.png`)
        await fs.promises.writeFile(file, image.toPNG())
        return { text: null, path: file }
    }

    const writeClipboard = text => require('electron').clipboard.writeText(text)

    return { listDir, saveUpload, readClipboard, writeClipboard }
}
