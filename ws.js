// Minimal WebSocket server side (RFC 6455): handshake, framing, ping/pong, close.
// No extensions (permessage-deflate) — add if bandwidth on mobile matters.
const crypto = require('crypto')

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const MAX_MESSAGE = 1 << 20
const MAX_BACKLOG = 8 << 20

function frame (opcode, payload) {
    const len = payload.length
    const head = len < 126 ? Buffer.from([0x80 | opcode, len])
        : len < 65536 ? Buffer.from([0x80 | opcode, 126, len >> 8, len & 255])
        : Buffer.concat([Buffer.from([0x80 | opcode, 127]), (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(len)); return b })()])
    return Buffer.concat([head, payload])
}

/** Bytes the frame at the start of `buf` needs in total, as far as its header tells yet. Throws when too large. */
function frameSize (buf) {
    if (buf.length < 2) return 2
    const len = buf[1] & 0x7f
    if (len < 126) return 6 + len
    if (len === 126) return buf.length < 4 ? 4 : 8 + buf.readUInt16BE(2)
    if (buf.length < 10) return 10
    const big = buf.readBigUInt64BE(2)
    if (big > BigInt(MAX_MESSAGE)) throw new Error('frame too large')
    return 14 + Number(big)
}

/** Parses client frames from `buf`; returns [frames, rest]. Throws on protocol errors. */
function parse (buf) {
    const frames = []
    for (;;) {
        if (buf.length < 2) break
        const fin = !!(buf[0] & 0x80)
        const opcode = buf[0] & 0x0f
        if (!(buf[1] & 0x80)) throw new Error('unmasked client frame')
        let len = buf[1] & 0x7f
        let off = 2
        if (len === 126) {
            if (buf.length < 4) break
            len = buf.readUInt16BE(2)
            off = 4
        } else if (len === 127) {
            if (buf.length < 10) break
            const big = buf.readBigUInt64BE(2)
            if (big > BigInt(MAX_MESSAGE)) throw new Error('frame too large')
            len = Number(big)
            off = 10
        }
        if (len > MAX_MESSAGE) throw new Error('frame too large')
        if (buf.length < off + 4 + len) break
        const mask = buf.subarray(off, off + 4)
        const payload = Buffer.from(buf.subarray(off + 4, off + 4 + len))
        for (let i = 0; i < len; i++) payload[i] ^= mask[i & 3]
        frames.push({ fin, opcode, payload })
        buf = buf.subarray(off + 4 + len)
    }
    return [frames, buf]
}

/**
 * Completes the upgrade on `socket` and returns a connection:
 * `{ send(stringOrBuffer), close(code?), onMessage(fn(data, isBinary)), onClose(fn) }`.
 */
function accept (req, socket) {
    const key = req.headers['sec-websocket-key']
    if (!key || req.headers.upgrade?.toLowerCase() !== 'websocket') {
        socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
        return null
    }
    const hash = crypto.createHash('sha1').update(key + GUID).digest('base64')
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${hash}\r\n\r\n`)
    socket.setNoDelay(true)

    let onMessage = () => {}
    let onClose = () => {}
    // Unparsed bytes as a list, joined only once a whole frame is in, so a slow 1 MB frame is not re-copied per chunk.
    let chunks = []
    let pending = 0
    let need = 2
    let parts = []
    let partsOpcode = 0
    let closed = false

    const conn = {
        get closed () { return closed },
        send (data) {
            if (closed) return
            // A client that cannot keep up (`cat` of a huge log over slow Wi-Fi) is dropped instead of buffered forever.
            if (socket.writableLength > MAX_BACKLOG) return conn.close(1008)
            socket.write(typeof data === 'string' ? frame(1, Buffer.from(data)) : frame(2, data))
        },
        close (code = 1000) {
            if (closed) return
            closed = true
            const b = Buffer.alloc(2)
            b.writeUInt16BE(code)
            socket.end(frame(8, b))
            // A peer that never answers the close is cut off.
            setTimeout(() => socket.destroy(), 2000).unref?.()
        },
        onMessage (fn) { onMessage = fn },
        onClose (fn) { onClose = fn },
    }

    // A peer that went silent (phone off the Wi-Fi, app killed without a goodbye) is cut off: a ping every 15 s,
    // and nothing heard for 45 s ends the connection, so the server lets go of it (and its terminal size).
    let heard = Date.now()
    const beat = setInterval(() => {
        if (Date.now() - heard > 45000) return socket.destroy()
        if (!closed) socket.write(frame(9, Buffer.alloc(0)))
    }, 15000)
    beat.unref?.()

    socket.on('data', chunk => {
        heard = Date.now()
        if (closed) return
        chunks.push(chunk)
        pending += chunk.length
        if (pending < need) return
        let frames, rest
        try {
            [frames, rest] = parse(chunks.length === 1 ? chunks[0] : Buffer.concat(chunks))
            need = frameSize(rest)
        } catch {
            conn.close(1002)
            socket.destroy()
            return
        }
        chunks = rest.length ? [rest] : []
        pending = rest.length
        for (const f of frames) {
            if (f.opcode === 8) return conn.close()
            if (f.opcode === 9) { socket.write(frame(10, f.payload)); continue }
            if (f.opcode === 10) continue
            if (f.opcode !== 0) partsOpcode = f.opcode
            parts.push(f.payload)
            if (parts.reduce((n, p) => n + p.length, 0) > MAX_MESSAGE) return conn.close(1009)
            if (!f.fin) continue
            const data = Buffer.concat(parts)
            parts = []
            onMessage(partsOpcode === 1 ? data.toString('utf8') : data, partsOpcode === 2)
        }
    })
    socket.on('close', () => {
        clearInterval(beat)
        closed = true
        onClose()
    })
    socket.on('error', () => socket.destroy())
    return conn
}

module.exports = { accept, parse, frame, frameSize }

// Self-check: node ws.js
if (require.main === module) {
    const assert = require('assert')
    const mask = Buffer.from([1, 2, 3, 4])
    const clientFrame = (op, text, fin = true) => {
        const p = Buffer.from(text)
        const masked = Buffer.from(p.map((b, i) => b ^ mask[i & 3]))
        const len = p.length
        const head = len < 126 ? Buffer.from([(fin ? 0x80 : 0) | op, 0x80 | len]) : Buffer.from([(fin ? 0x80 : 0) | op, 0x80 | 126, len >> 8, len & 255])
        return Buffer.concat([head, mask, masked])
    }
    const big = 'x'.repeat(70000)
    const all = Buffer.concat([clientFrame(1, 'hi'), clientFrame(1, 'y'.repeat(300)), clientFrame(1, 'tail')])
    const [f1, r1] = parse(all.subarray(0, all.length - 3))
    assert.deepStrictEqual(f1.map(f => f.payload.toString()), ['hi', 'y'.repeat(300)])
    const [f2, r2] = parse(Buffer.concat([r1, all.subarray(all.length - 3)]))
    assert.strictEqual(f2[0].payload.toString(), 'tail')
    assert.strictEqual(r2.length, 0)
    assert.throws(() => parse(Buffer.from([0x81, 0x02, 0x68, 0x69])), /unmasked/)
    assert.strictEqual(frame(1, Buffer.from(big)).length, 70000 + 10)
    assert.strictEqual(frame(1, Buffer.from('y'.repeat(300))).length, 304)
    assert.strictEqual(frameSize(clientFrame(1, 'hi')), clientFrame(1, 'hi').length)
    assert.strictEqual(frameSize(clientFrame(1, 'y'.repeat(300))), clientFrame(1, 'y'.repeat(300)).length)
    assert.strictEqual(frameSize(Buffer.from([0x81])), 2)
    assert.throws(() => frameSize(Buffer.from([0x81, 0xff, 0, 0, 0, 0, 1, 0, 0, 0])), /too large/)
    console.log('ws ok')
}
