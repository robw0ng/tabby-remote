// The WebSocket framing: split and joined frames, unmasked frames refused, sizes, and frames too large to take.
const test = require('node:test')
const assert = require('node:assert')
const { parse, frame, frameSize } = require('../ws')

test('ws frames', () => {
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
})
