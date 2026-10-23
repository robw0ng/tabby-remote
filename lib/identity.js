const crypto = require('crypto')
const http = require('http')

const der = key => key.export({ type: 'spki', format: 'der' }).toString('base64')
const publicKey = b64 => crypto.createPublicKey({ key: Buffer.from(b64, 'base64'), format: 'der', type: 'spki' })
const privateKey = b64 => crypto.createPrivateKey({ key: Buffer.from(b64, 'base64'), format: 'der', type: 'pkcs8' })
const plainAddress = a => String(a ?? '').replace(/^::ffff:/, '')
// What a computer signs to prove it holds its identity: the asker's nonce, the address it saw the question come from
// (so a host that passes the question on to the real computer fails: it would be the asker), and its X25519 key.
const signed = (nonce, address, box) => Buffer.from(`tabby-remote identity v1\n${nonce}\n${plainAddress(address)}\n${box}`)

const BASE32 = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
/** The fingerprint people compare: 16 characters (80 bits) of SHA-256 over both public keys, as XXXX-XXXX-XXXX-XXXX:
 *  too long to grind a key that matches another computer's. */
function fingerprint (sign, box) {
    const h = crypto.createHash('sha256').update(`${sign}.${box}`).digest()
    let bits = 0n
    for (const b of h.subarray(0, 10)) bits = (bits << 8n) | BigInt(b)
    let s = ''
    for (let i = 0; i < 16; i++) s += BASE32[Number((bits >> BigInt(75 - i * 5)) & 31n)]
    return s.match(/.{4}/g).join('-')
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
                resolve(res.statusCode === 200 ? JSON.parse(text) : { status: res.statusCode, ...JSON.parse(text) })
            } catch {
                resolve(null)
            }
        })
    })
    req.on('error', () => resolve(null))
    req.on('timeout', () => req.destroy())
    req.end(data)
})

// Sealed messages for linking: X25519 with a fresh key of the sender's, HKDF-SHA256, AES-256-GCM. Only the computer
// holding that identity can read the password or code; its answer (the token) is sealed back with the same key.
const INFO = Buffer.from('tabby-remote link v1')
function sealWith (key, obj) {
    const iv = crypto.randomBytes(12)
    const c = crypto.createCipheriv('aes-256-gcm', key, iv)
    const ct = Buffer.concat([c.update(JSON.stringify(obj)), c.final()])
    return { iv: iv.toString('base64'), ct: ct.toString('base64'), tag: c.getAuthTag().toString('base64') }
}
function openWith (key, s) {
    const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(s.iv, 'base64'))
    d.setAuthTag(Buffer.from(s.tag, 'base64'))
    return JSON.parse(Buffer.concat([d.update(Buffer.from(s.ct, 'base64')), d.final()]).toString('utf8'))
}
const derive = (shared, epk) => Buffer.from(crypto.hkdfSync('sha256', shared, Buffer.from(epk, 'base64'), INFO, 32))

/** This computer's long-term identity (made once, kept in its settings file), and linking safely to another one. */
module.exports = ctx => {
    const { store } = ctx
    if (!store.identity) {
        const s = crypto.generateKeyPairSync('ed25519')
        const b = crypto.generateKeyPairSync('x25519')
        store.identity = { sign: der(s.publicKey), signKey: s.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'), box: der(b.publicKey), boxKey: b.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64') }
        ctx.save()
    }
    const me = store.identity
    const myFingerprint = () => fingerprint(me.sign, me.box)

    // Tickets: a sealed sign-in must carry one, used once, so a recorded one cannot be sent again. At most 100 live.
    const tickets = new Map()

    /** POST /api/identity's answer (no sign-in): the public keys, signed together with the nonce and asker's address,
     *  and a ticket for one sealed sign-in in the next 2 minutes. */
    function identityAnswer (nonce, address) {
        if (typeof nonce !== 'string' || nonce.length < 32 || nonce.length > 128) return null
        const ticket = crypto.randomBytes(16).toString('hex')
        tickets.set(ticket, Date.now() + 120000)
        if (tickets.size > 100) tickets.delete(tickets.keys().next().value)
        return { sign: me.sign, box: me.box, sig: crypto.sign(null, signed(nonce, address, me.box), privateKey(me.signKey)).toString('base64'), ticket }
    }

    /**
     * Who answers at `base`: its keys and fingerprint, when it proves it holds them for this question from this
     * computer's address; null otherwise. `pinned`: the keys it must have (a linked computer), else any.
     */
    async function identityOf (base, pinned = null) {
        const nonce = crypto.randomBytes(32).toString('hex')
        const local = {}
        const r = await small(base, 'api/identity', { nonce }, local)
        if (typeof r?.sign !== 'string' || typeof r.box !== 'string' || typeof r.sig !== 'string' || !local.address) return null
        if (pinned && (r.sign !== pinned.sign || r.box !== pinned.box)) return null
        try {
            if (!crypto.verify(null, signed(nonce, local.address, r.box), publicKey(r.sign), Buffer.from(r.sig, 'base64'))) return null
        } catch {
            return null
        }
        return { sign: r.sign, box: r.box, fingerprint: fingerprint(r.sign, r.box), ticket: typeof r.ticket === 'string' ? r.ticket : null }
    }

    /** Sends `obj` to the computer with this identity (from identityOf), sealed with its ticket; resolves with its sealed
     *  answer opened, or an error. */
    async function sealedPost (base, p, { box, ticket }, obj) {
        const eph = crypto.generateKeyPairSync('x25519')
        const epk = der(eph.publicKey)
        const key = derive(crypto.diffieHellman({ privateKey: eph.privateKey, publicKey: publicKey(box) }), epk)
        const r = await small(base, p, { sealed: { epk, ...sealWith(key, { ...obj, ticket }) } })
        if (!r) return { error: 'no answer' }
        if (!r.sealed) return { error: r.error ?? `answered ${r.status}` }
        try {
            return openWith(key, r.sealed)
        } catch {
            return { error: 'an answer that does not open' }
        }
    }

    /** The receiving end: a sealed request opened (null when it does not open, or its ticket is unknown, old or used),
     *  and how to seal the answer. */
    function openSealed (sealed) {
        let body, key
        try {
            key = derive(crypto.diffieHellman({ privateKey: privateKey(me.boxKey), publicKey: publicKey(sealed.epk) }), sealed.epk)
            body = openWith(key, sealed)
        } catch {
            return null
        }
        const until = tickets.get(body?.ticket)
        tickets.delete(body?.ticket)
        if (!until || until < Date.now()) return null
        return { body, seal: obj => ({ sealed: sealWith(key, obj) }) }
    }

    return { myFingerprint, identityAnswer, identityOf, sealedPost, openSealed, small }
}
