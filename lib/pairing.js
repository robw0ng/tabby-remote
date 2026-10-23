const crypto = require('crypto')
const { sha } = require('./secrets')
const { phoneAddress } = require('./net')

const qrSvg = (text, options) => {
    const qr = require('qrcode-generator')(0, 'M')
    qr.addData(text)
    qr.make()
    return qr.createSvgTag(options)
}

/** QR pairing: one 6-digit code, single use, 2 minutes, shown in a popup over Tabby. */
module.exports = ctx => {
    const { store } = ctx
    let pairing = null
    let overlay = null
    const qrAsks = new Map()

    function newPairing () {
        const code = String(crypto.randomInt(0, 1e6)).padStart(6, '0')
        pairing = { code, expires: Date.now() + 120000, url: `http://${phoneAddress()}:${ctx.listeningPort}/#pair=${code}` }
        return pairing
    }

    // A used code still works for 30 s, because a phone can load the QR link twice (preview, then tab).
    // The 2-minute life still caps it.
    function pair (code) {
        const ok = !!pairing && pairing.expires > Date.now() && crypto.timingSafeEqual(sha(String(code ?? '')), sha(pairing.code))
        if (ok) pairing.expires = Math.min(pairing.expires, pairing.usedUntil ??= Date.now() + 30000)
        return ok
    }

    function closeQr () {
        // A code nobody used dies with the popup; a used one keeps its 30 s grace.
        if (overlay && pairing && !pairing.usedUntil) pairing = null
        clearInterval(overlay?.timer)
        overlay?.el.remove()
        overlay = null
    }

    function showQr () {
        if (!store.enabled) return ctx.notifications.notice('Phone access is off: turn it on in Settings > Phone access')
        closeQr()
        const el = document.createElement('div')
        el.style.cssText = 'position:fixed;inset:0;z-index:10000;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.6);font:14px system-ui,sans-serif;color:#eee'
        const card = document.createElement('div')
        card.style.cssText = 'background:#1f1f1f;border:1px solid #333;border-radius:10px;padding:20px 24px;text-align:center;box-shadow:0 8px 24px rgba(0,0,0,.5);max-width:340px'
        el.appendChild(card)
        el.addEventListener('mousedown', e => e.target === el && closeQr())
        overlay = { el, timer: null }

        // The QR is drawn once per code and stays still (a camera cannot lock onto one that is redrawn); only the
        // countdown changes each second. Dark modules on white, 8 px each, with the 4-module white margin readers need.
        // With Tailscale, a Wi-Fi / Tailscale switch: the same code, linked through the computer's Tailscale name.
        let tailscale = null
        let via = 'wifi'
        let shown = null
        const button = (text, onclick, on) => {
            const b = document.createElement('button')
            b.textContent = text
            b.style.cssText = `padding:4px 14px;border:1px solid #444;background:${on ? '#3a3a3a' : '#2b2b2b'};color:${on ? '#fff' : '#999'};cursor:pointer`
            b.onclick = onclick
            return b
        }
        const render = () => {
            // A code already used gets replaced, so the QR on screen is always a fresh one.
            if (!pairing || pairing.expires <= Date.now() || pairing.usedUntil) newPairing()
            const left = Math.max(0, Math.ceil((pairing.expires - Date.now()) / 1000))
            const countdown = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`
            const url = via === 'tailscale' ? `http://${tailscale}:${ctx.listeningPort}/#pair=${pairing.code}` : pairing.url
            if (shown === url) {
                card.querySelector('[data-left]').textContent = countdown
                return
            }
            shown = url
            card.innerHTML = `<div style="font-weight:600;font-size:15px;margin-bottom:12px">Phone access</div>
                <div data-via style="margin-bottom:12px;display:flex;justify-content:center"></div>
                <div style="background:#fff;border-radius:6px;display:inline-block;line-height:0">${qrSvg(url, { cellSize: 8, margin: 4, scalable: false })}</div>
                <div style="margin-top:12px;color:#aaa"><b style="color:#eee;letter-spacing:2px">${pairing.code}</b> · <span data-left>${countdown}</span></div>
                <div style="margin-top:6px;color:#888;font-size:12px;user-select:text">${url.split('#')[0]}</div>
                <div style="margin-top:4px;color:#888;font-size:12px" title="A computer linking with this code shows it: check they match">Fingerprint <span style="color:#ccc;letter-spacing:1px">${ctx.myFingerprint()}</span></div>`
            const switcher = card.querySelector('[data-via]')
            if (tailscale) {
                const pick = v => () => {
                    via = v
                    render()
                }
                switcher.append(button('Wi-Fi', pick('wifi'), via === 'wifi'), button('Tailscale', pick('tailscale'), via === 'tailscale'))
                switcher.firstChild.style.borderRadius = '6px 0 0 6px'
                switcher.lastChild.style.borderRadius = '0 6px 6px 0'
            } else {
                switcher.remove()
            }
            const close = document.createElement('button')
            close.textContent = 'Close'
            close.style.cssText = 'margin-top:14px;padding:6px 16px;border-radius:6px;border:1px solid #444;background:#2b2b2b;color:#eee;cursor:pointer'
            close.onclick = closeQr
            card.appendChild(close)
        }
        render()
        overlay.timer = setInterval(render, 1000)
        document.body.appendChild(el)
        const mine = overlay
        ctx.tailscaleHost().then(host => {
            if (!host || overlay !== mine) return
            tailscale = host
            shown = null
            render()
        })
    }

    /** A device asks for the QR on this screen (one not yet signed in, or one pairing another). No sign-in needed: it
     *  only shows the code here, where pairing already requires being. Once per 10 s per address. */
    function askQr (addr) {
        if (Date.now() - (qrAsks.get(addr) ?? 0) < 10000) return false
        qrAsks.set(addr, Date.now())
        showQr()
        return true
    }

    ctx.cleanup.push(closeQr)
    return { newPairing, pair, showQr, closeQr, askQr, qrSvg }
}
