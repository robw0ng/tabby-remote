// ---- 📁: the Shared folders of the computer this page is on (Tabby's Settings › Phone access) ----

// A preview shows this much of a text file at most; images up to IMAGE_MAX.
const TEXT_MAX = 256 << 10
const IMAGE_MAX = 20 << 20
const IMAGE = /\.(png|jpe?g|gif|webp|bmp|svg|ico|avif)$/i
const TEXT = /\.(txt|md|markdown|log|json|jsonl|ya?ml|toml|ini|cfg|conf|xml|html?|css|scss|less|[cm]?[jt]sx?|vue|svelte|py|rb|go|rs|java|kt|cs|cpp|cc|[ch]|hpp|php|sh|bash|zsh|ps1|psm1|bat|cmd|sql|csv|tsv|env|gitignore|dockerfile|lock|gradle|properties|swift|lua|r|pl|ex|exs|dart)$/i

const files = { at: null, roots: [], sep: '\\' }

const filesApi = (op, query) => api(`/api/files/${op}?${new URLSearchParams(query)}`)
const sizeText = n => n < 1024 ? `${n} B` : n < 1 << 20 ? `${(n / 1024).toFixed(0)} KB` : n < 1 << 30 ? `${(n / (1 << 20)).toFixed(1)} MB` : `${(n / (1 << 30)).toFixed(1)} GB`
const joinPath = (dir, name) => dir.endsWith(files.sep) ? dir + name : dir + files.sep + name
// The folder holding p; at the top of a drive or the file system, that root itself (C:\, /).
const folderOf = p => {
    const i = p.lastIndexOf(files.sep)
    const up = p.slice(0, i)
    return !up || /^[A-Za-z]:$/.test(up) ? p.slice(0, i + 1) : up
}
const rootOf = p => files.roots.find(r => p === r.path || p.startsWith(r.path.endsWith(files.sep) ? r.path : r.path + files.sep))

function openFiles () {
    $('files').hidden = false
    $('files-btn').ariaPressed = 'true'
    showFolder(files.at)
}
function closeFiles () {
    $('files').hidden = true
    $('files-btn').ariaPressed = 'false'
    if (term && !touch.matches) term.focus()
}
$('files-btn').onclick = () => $('files').hidden ? openFiles() : closeFiles()
$('files-close').onclick = closeFiles

/** One folder (null: the shared folders themselves), or a message. */
async function showFolder (dir) {
    const list = $('files-list')
    $('files-preview').hidden = true
    list.hidden = false
    const r = await filesApi(dir ? 'list' : 'roots', dir ? { path: dir } : {}).catch(() => null)
    const body = r && await r.json().catch(() => null)
    if (!r?.ok) {
        // A folder that went away (or stopped being shared): back to the top.
        if (dir) return showFolder(null)
        return showMessage(r?.status === 401 ? 'Signed out' : 'Could not list the shared folders (a Tabby restart may be needed)')
    }
    if (!dir) {
        files.roots = body
        files.sep = body[0]?.path.includes('/') && !body[0].path.includes('\\') ? '/' : '\\'
        if (!body.length) return showMessage('Share folders in Settings', 'On the computer: Tabby › Settings › Phone access › Shared folders. Only those folders show here.')
    }
    files.at = dir
    const root = dir && rootOf(dir)
    // Where we are: the shared folder's name, then the folders below it.
    $('files-title').textContent = !dir ? 'Shared folders' : root ? [root.name, ...dir.slice(root.path.length).split(files.sep).filter(Boolean)].join(' › ') : dir
    $('files-up').hidden = !dir
    $('files-upload').hidden = !dir
    $('files-paste').hidden = !dir || !term
    const entries = dir
        ? body.sort((a, b) => (a.type === 'dir' ? 0 : 1) - (b.type === 'dir' ? 0 : 1) || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }))
        : body.map(r => ({ name: r.name, type: 'dir', path: r.path, size: 0, mtime: null }))
    list.replaceChildren(...entries.length ? entries.map(e => {
        const p = e.path ?? joinPath(dir, e.name)
        return el('button', { className: 'file-row', onclick: () => e.type === 'dir' ? showFolder(p) : showFile(p, e) },
            el('span', { className: 'file-icon', textContent: e.type === 'dir' ? '📁' : IMAGE.test(e.name) ? '🖼️' : '📄', ariaHidden: 'true' }),
            el('span', { className: 'file-name', textContent: e.name }),
            el('span', { className: 'file-meta', textContent: e.type === 'dir' ? '' : [sizeText(e.size), e.mtime && new Date(e.mtime).toLocaleDateString()].filter(Boolean).join(' · ') }))
    }) : [el('p', { className: 'files-empty', textContent: 'Empty folder' })])
    list.scrollTop = 0
}

function showMessage (title, text) {
    files.at = null
    $('files-title').textContent = 'Shared folders'
    for (const id of ['files-up', 'files-upload', 'files-paste']) $(id).hidden = true
    $('files-preview').hidden = true
    $('files-list').hidden = false
    $('files-list').replaceChildren(el('div', { className: 'files-empty' }, el('b', { textContent: title }), text ? el('p', { textContent: text }) : null))
}

/** A file: a preview (text or image), Download and Paste path. */
async function showFile (p, e) {
    const box = $('files-preview')
    $('files-list').hidden = true
    box.hidden = false
    $('files-title').textContent = e.name
    $('files-up').hidden = false
    $('files-upload').hidden = true
    $('files-paste').hidden = true
    files.at = folderOf(p)
    const view = el('div', { className: 'file-view', textContent: 'Loading…' })
    box.replaceChildren(el('div', { className: 'file-actions' },
        el('button', { textContent: 'Download', onclick: () => download(p, e.name) }),
        term ? el('button', { textContent: 'Paste path', onclick: () => pasteHere(p) }) : null),
        el('div', { className: 'file-meta', textContent: `${sizeText(e.size)}${e.mtime ? ' · ' + new Date(e.mtime).toLocaleString() : ''}` }),
        view)
    if (IMAGE.test(e.name) && e.size <= IMAGE_MAX) {
        const r = await filesApi('read', { path: p }).catch(() => null)
        if (!r?.ok) return void (view.textContent = 'Could not read it')
        // The server says octet-stream; an SVG only shows as image/svg+xml.
        const blob = await r.blob()
        const img = el('img', { alt: e.name, src: URL.createObjectURL(/\.svg$/i.test(e.name) ? new Blob([blob], { type: 'image/svg+xml' }) : blob) })
        img.onload = img.onerror = () => URL.revokeObjectURL(img.src)
        return view.replaceChildren(img)
    }
    if (TEXT.test(e.name) || !/\.[^./\\]+$/.test(e.name)) {
        const r = await fetch(`/api/files/read?${new URLSearchParams({ path: p })}`, { headers: { Authorization: `Bearer ${token}`, ...e.size > TEXT_MAX ? { Range: `bytes=0-${TEXT_MAX - 1}` } : {} } }).catch(() => null)
        if (!r?.ok) return void (view.textContent = 'Could not read it')
        const text = await r.text()
        // A file that is not text after all (no extension, binary inside).
        if (/\u0000/.test(text.slice(0, 4096))) return void (view.textContent = 'No preview')
        return view.replaceChildren(el('pre', { textContent: text + (e.size > TEXT_MAX ? `\n… (first ${sizeText(TEXT_MAX)} of ${sizeText(e.size)})` : '') }))
    }
    view.textContent = 'No preview'
}

/** Saves the file on this device. ponytail: the whole file passes through memory (a Blob); fine for phone-sized
 *  files, a streamed download link would need the token in the URL. */
async function download (p, name) {
    setStatus(`Downloading ${name}…`)
    const r = await filesApi('read', { path: p }).catch(() => null)
    if (!r?.ok) {
        setStatus(null)
        return flash('Download failed')
    }
    const a = el('a', { href: URL.createObjectURL(await r.blob()), download: name })
    setStatus(null)
    document.body.append(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(a.href), 60000)
}

/** Types the path at the terminal's cursor (quoted when it has spaces) and goes back to the terminal. */
function pasteHere (p) {
    if (!term) return
    closeFiles()
    pastePaths([p])
}
$('files-paste').onclick = () => files.at && pasteHere(files.at)
$('files-up').onclick = () => {
    const root = files.at && rootOf(files.at)
    // From a file's preview, or below a shared folder: up one; from a shared folder itself: the list of them.
    if (!$('files-preview').hidden) return showFolder(files.at)
    showFolder(!root || files.at === root.path ? null : folderOf(files.at))
}

// Upload into the open folder: a file that is already there is kept, and the new one gets a free name ("a (2).txt").
$('files-upload').onclick = () => files.at && $('files-pick').click()
$('files-pick').addEventListener('change', async () => {
    const picked = [...$('files-pick').files]
    $('files-pick').value = ''
    const dir = files.at
    let failed = 0
    for (const f of picked) {
        const dot = f.name.lastIndexOf('.') > 0 ? f.name.lastIndexOf('.') : f.name.length
        let ok = false
        for (let n = 1; n < 50 && !ok; n++) {
            const name = n === 1 ? f.name : `${f.name.slice(0, dot)} (${n})${f.name.slice(dot)}`
            const status = await put(joinPath(dir, name), f, pct => setStatus(`Uploading ${f.name}… ${pct}%`))
            if (status !== 409) {
                ok = status === 200
                break
            }
        }
        if (!ok) failed++
    }
    setStatus(null)
    if (failed) flash(failed === picked.length ? 'Upload failed' : 'Some files failed')
    if (files.at === dir && !$('files').hidden) showFolder(dir)
})

/** PUT /api/files/write with upload progress (fetch has none); resolves with the status (0: no connection). */
const put = (p, file, progress) => new Promise(resolve => {
    const x = new XMLHttpRequest()
    x.open('PUT', `/api/files/write?${new URLSearchParams({ path: p })}`)
    x.setRequestHeader('Authorization', `Bearer ${token}`)
    x.upload.onprogress = e => e.lengthComputable && progress(Math.round(e.loaded / e.total * 100))
    x.onload = () => resolve(x.status)
    x.onerror = () => resolve(0)
    x.send(file)
})
