const fs = require('fs')
const os = require('os')
const path = require('path')

const MAX_UPLOAD = 50 << 20
// Files stay in the OS temp folder; clear tabby-remote/uploads there if it ever grows.
const UPLOADS = path.join(os.tmpdir(), 'tabby-remote', 'uploads')

/** Files for the API: uploads from a device, and this computer's clipboard (Shared folders are share.js). */
module.exports = ctx => {
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

    return { saveUpload, readClipboard, writeClipboard }
}
