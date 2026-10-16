// ---- Files from this device: Attach, a pasted image, a drop; each uploads and its path is typed ----

$('attach').onclick = () => term && $('file-pick').click()

// Attach: each picked file uploads to a temp folder on the PC, then its path is pasted at the cursor.
$('file-pick').addEventListener('change', () => {
    const files = [...$('file-pick').files]
    $('file-pick').value = ''
    closeSheet()
    uploadFiles(files)
})

/** Uploads files to the PC (Attach, a pasted image, a drop) and types their paths at the cursor, quoted, one each. */
async function uploadFiles (files) {
    if (!files.length || !term) return
    setStatus(`Uploading ${files.length === 1 ? files[0].name || 'image' : files.length + ' files'}…`)
    const paths = []
    for (const f of files) {
        const r = await fetch('/api/upload', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'X-Filename': encodeURIComponent(f.name || 'photo.jpg') }, body: f }).catch(() => null)
        if (r?.ok) paths.push((await r.json()).path)
    }
    setStatus(null)
    if (paths.length) pastePaths(paths)
    if (paths.length < files.length) flash(paths.length ? 'Some files failed' : 'Upload failed (a Tabby restart may be needed)')
}

/** The files in a paste or a drop: real files, or an image copied to the clipboard (a screenshot has no file). */
function filesIn (data) {
    const files = [...(data?.files ?? [])]
    if (files.length) return files
    return [...(data?.items ?? [])].filter(i => i.kind === 'file').map(i => i.getAsFile()).filter(Boolean)
}

// Pasting an image or a file (a screenshot with Ctrl+V): it uploads, as Attach does, and its path is typed. Text pastes
// are left to the terminal. Captured first, so it runs before xterm's own paste and the predictions box's.
document.addEventListener('paste', e => {
    const files = filesIn(e.clipboardData)
    if (!files.length || !term || !$('term-view').contains(document.activeElement) && document.activeElement?.id !== 'predict') return
    e.preventDefault()
    e.stopPropagation()
    uploadFiles(files.map((f, i) => f.name && f.name !== 'image.png' ? f : new File([f], `pasted-${Date.now()}-${i + 1}.${(f.type.split('/')[1] || 'png').replace('jpeg', 'jpg')}`, { type: f.type })))
}, true)

// Dropping files onto the terminal: uploaded, their paths typed, as Attach does. A hint shows while dragging over it.
{
    const area = $('term-view')
    let depth = 0
    const hasFiles = e => [...(e.dataTransfer?.types ?? [])].includes('Files')
    area.addEventListener('dragenter', e => {
        if (!hasFiles(e) || !term) return
        depth++
        area.classList.add('dropping')
    })
    area.addEventListener('dragover', e => {
        if (!hasFiles(e) || !term) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'copy'
    })
    area.addEventListener('dragleave', () => {
        if (--depth <= 0) {
            depth = 0
            area.classList.remove('dropping')
        }
    })
    area.addEventListener('drop', e => {
        depth = 0
        area.classList.remove('dropping')
        if (!hasFiles(e) || !term) return
        e.preventDefault()
        uploadFiles(filesIn(e.dataTransfer))
        term.focus()
    })
}
