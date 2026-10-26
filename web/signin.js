// ---- Sign in ----

function deviceName () {
    const ua = navigator.userAgent
    return /iPhone|iPad|Android/.exec(ua)?.[0] ?? (/Mac OS X|Macintosh/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /Linux|CrOS/.test(ua) ? 'Linux' : 'Browser')
}

function signedIn (t) {
    token = t
    localStorage.setItem('tabby-remote-token', t)
    $('signin').hidden = true
    start()
}

function signOut (msg) {
    token = null
    localStorage.removeItem('tabby-remote-token')
    hideMenu()
    // Detach first, so their close handlers do not reconnect and wipe the message below.
    const [e, s] = [events, socket]
    events = socket = null
    e?.close()
    s?.close()
    $('signin-err').textContent = msg ?? ''
    $('signin').hidden = false
    $('pw-form').hidden = true
    // Whether Tabby has a password set: "Sign in with password" then shows the field, else says where to set one.
    fetch('/api/info').then(r => r.json()).then(i => { hasPassword = !!i.password }).catch(() => {})
}

let hasPassword = false
$('pw-btn').onclick = () => {
    if (!hasPassword) {
        $('signin-err').textContent = 'No password is set yet. On the PC: Tabby Settings › Devices › Phones and browsers › Password.'
        return
    }
    $('signin-err').textContent = ''
    $('pw-form').hidden = false
    $('pw').focus()
}

async function pairWith (code) {
    const r = await fetch('/api/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, deviceName: deviceName() }) })
    if (r.ok) return signedIn((await r.json()).token)
    // An old QR link must not undo a sign-in this browser already has.
    if (token) return start()
    signOut(r.status === 429 ? 'Too many tries. Wait 1 min.' : 'Code expired. Use the new one in Tabby.')
}

async function tryPair () {
    const code = /pair=(\d{6})/.exec(location.hash)?.[1]
    if (!code) return false
    history.replaceState(null, '', location.pathname)
    await pairWith(code)
    return true
}

// Six one-digit boxes: typing moves on, Backspace moves back, a pasted or autofilled code spreads over them.
const boxes = Array.from({ length: 6 }, (_, i) => el('input', {
    inputMode: 'numeric',
    autocomplete: i === 0 ? 'one-time-code' : 'off',
    ariaLabel: `Digit ${i + 1}`,
    maxLength: 6,
}))
$('code').append(...boxes)
const fillFrom = (i, digits) => {
    for (const d of digits) {
        if (i > 5) break
        boxes[i++].value = d
    }
    boxes[Math.min(i, 5)].focus()
    const code = boxes.map(b => b.value).join('')
    if (/^\d{6}$/.test(code)) {
        boxes.forEach(b => { b.value = '' })
        pairWith(code)
    }
}
boxes.forEach((b, i) => {
    b.addEventListener('input', () => {
        const digits = b.value.replace(/\D/g, '')
        b.value = ''
        if (digits) fillFrom(i, digits)
    })
    b.addEventListener('keydown', e => {
        if (e.key === 'Backspace' && !b.value && i > 0) {
            boxes[i - 1].value = ''
            boxes[i - 1].focus()
            e.preventDefault()
        }
        if (e.key === 'ArrowLeft' && i > 0) boxes[i - 1].focus()
        if (e.key === 'ArrowRight' && i < 5) boxes[i + 1].focus()
    })
    b.addEventListener('focus', () => b.select())
})
$('code-form').onsubmit = e => e.preventDefault()

// ---- Pair by photo: show the QR on the PC, take one photo of it, read the code from the photo ----
// (A live camera needs https, which a page on the Wi-Fi does not have; a photo from the phone's camera works.)

const requestQr = () => fetch('/api/qr', { method: 'POST' }).catch(() => null)

let jsqrLoaded = null
const loadJsQr = () => (jsqrLoaded ??= new Promise((resolve, reject) => {
    document.head.append(el('script', { src: 'jsqr.js', onload: resolve, onerror: reject }))
}))

/** The pairing code in a photo of the QR, or null. */
async function codeFromPhoto (file) {
    await loadJsQr()
    const img = await createImageBitmap(file)
    // Large enough to read a QR across a room, small enough to be quick.
    const scale = Math.min(1, 1600 / Math.max(img.width, img.height))
    const w = Math.round(img.width * scale)
    const h = Math.round(img.height * scale)
    const canvas = el('canvas', { width: w, height: h })
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    ctx.drawImage(img, 0, 0, w, h)
    const found = window.jsQR(ctx.getImageData(0, 0, w, h).data, w, h)
    return /pair=(\d{6})/.exec(found?.data ?? '')?.[1] ?? null
}

$('scan-btn').onclick = () => {
    // The camera must open from the tap itself; the QR appears on the PC while it does.
    $('scan-pick').click()
    requestQr()
}
$('scan-pick').addEventListener('change', async () => {
    const file = $('scan-pick').files[0]
    $('scan-pick').value = ''
    if (!file) return
    $('signin-err').textContent = 'Reading the code…'
    const code = await codeFromPhoto(file).catch(() => null)
    if (!code) {
        $('signin-err').textContent = 'No QR found in the photo. Try again, a little closer.'
        return
    }
    $('signin-err').textContent = ''
    pairWith(code)
})

$('pw-show').onclick = () => {
    const show = $('pw').type === 'password'
    $('pw').type = show ? 'text' : 'password'
    $('pw-show').textContent = show ? 'Hide' : 'Show'
    $('pw-show').ariaPressed = String(show)
}

$('pw-form').onsubmit = async e => {
    e.preventDefault()
    const r = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: $('pw').value, deviceName: deviceName() }) })
    if (!r.ok) {
        $('signin-err').textContent = r.status === 429 ? 'Too many tries. Wait 1 min.' : 'Wrong password'
        return
    }
    signedIn((await r.json()).token)
}
