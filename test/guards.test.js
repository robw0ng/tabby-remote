// The checks that keep files, links and talk safe, without Tabby: node --test test/
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')

const share = require('../lib/share')
const move = require('../lib/move')
const talk = require('../lib/talk')

const quiet = { notice () {} }

// A shared folder, a file in it, a secret outside it, and a junction (a folder link) from inside to outside.
const tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'tr-test-'))
const root = path.join(tmp, 'shared')
const outside = path.join(tmp, 'outside')
fs.mkdirSync(root)
fs.mkdirSync(outside)
fs.writeFileSync(path.join(root, 'a.txt'), 'a')
fs.writeFileSync(path.join(outside, 'secret.txt'), 's')
fs.symlinkSync(outside, path.join(root, 'link'), 'junction')
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }))

/** One /api/files/<op> call: { status, body }. */
async function files (op, query, { folders = [root], phone = false, device = null, method = 'GET' } = {}) {
    const s = share({ store: { sharedFolders: folders, links: {}, devices: device ? [device] : [] }, save () {} })
    const url = new URL(`http://x/api/files/${op}?${new URLSearchParams(query)}`)
    const res = { headersSent: false, writeHead (status) { this.status = status }, end (b) { this.body = b ? JSON.parse(b) : null } }
    await s.handleFiles({ method, headers: {}, setTimeout () {} }, res, url, op, { phone, device })
    return { status: res.status, body: res.body, s }
}

test('a file inside a shared folder is reachable', async () => {
    assert.strictEqual((await files('stat', { path: path.join(root, 'a.txt') })).status, 200)
})
test('.. cannot leave a shared folder', async () => {
    const r = await files('stat', { path: path.join(root, '..', 'outside', 'secret.txt') })
    assert.deepStrictEqual([r.status, r.body.code], [403, 'outside'])
})
test('a link cannot leave a shared folder', async () => {
    const r = await files('stat', { path: path.join(root, 'link', 'secret.txt') })
    assert.deepStrictEqual([r.status, r.body.code], [403, 'outside'])
})
test('a network path is refused before anything is resolved', async () => {
    const r = await files('stat', { path: '\\\\host\\share\\x' })
    assert.deepStrictEqual([r.status, r.body.code], [400, 'bad-path'])
})
test('nothing is reachable while no folder is shared', async () => {
    const r = await files('stat', { path: path.join(root, 'a.txt') }, { folders: [] })
    assert.deepStrictEqual([r.status, r.body.code], [403, 'not-shared'])
})
test('a phone cannot delete', async () => {
    const r = await files('delete', {}, { phone: true, method: 'POST' })
    assert.deepStrictEqual([r.status, r.body.code], [403, 'not-a-computer'])
})
test('a download link works as signed, and not with another path', async () => {
    const device = { id: 'd1', hash: crypto.randomBytes(32).toString('hex') }
    const { body, s } = await files('list', { path: root, links: '1' }, { device })
    const link = new URL(body.find(e => e.name === 'a.txt').url, 'http://x').searchParams
    assert.ok(s.linkAllowed(link))
    link.set('path', path.join(outside, 'secret.txt'))
    assert.ok(!s.linkAllowed(link))
})

test('a chat zip holds only what an export makes', () => {
    const id = '0f8fad5b-d9cb-469f-a165-70867728950e'
    assert.ok(move.zipLooksRight(['meta.json', `${id}.jsonl`, `${id}/subagents/a.jsonl`]))
    for (const bad of [`../x`, `${id}/../../x`, '/etc/x', 'C:/x', `${id}\\x`, 'evil.ps1']) {
        assert.ok(!move.zipLooksRight(['meta.json', `${id}.jsonl`, bad]), bad)
    }
})

/** acceptLinkBack with the computer X announced at 192.168.1.5; `proves`: whether it proves its keys. */
function linkBack ({ proves = true } = {}) {
    const store = { links: {}, devices: [] }
    const m = move({ store, notifications: quiet, save () {}, otherComputers: () => [{ computerId: 'X', name: 'X', url: 'http://192.168.1.5:7681/' }], identityOf: async () => proves ? {} : null })
    const body = { token: 't', deviceId: 'd', computerId: 'X', sign: 's', box: 'b' }
    return { store, accept: (addr, device = {}) => m.acceptLinkBack(body, device, addr) }
}
test('link back only to the computer that asked, at its own address', async () => {
    const { store, accept } = linkBack()
    assert.strictEqual((await accept('192.168.1.9')).status, 403)
    assert.deepStrictEqual(store.links, {})
    const device = {}
    assert.strictEqual((await accept('::ffff:192.168.1.5', device)).status, 200)
    assert.strictEqual(store.links.X.token, 't')
    assert.strictEqual(device.computerId, 'X')
})
test('link back only when it proves its keys', async () => {
    const { store, accept } = linkBack({ proves: false })
    assert.strictEqual((await accept('192.168.1.5')).status, 403)
    assert.deepStrictEqual(store.links, {})
})

test('talk types only text, stamped with the linked computer it came from', async () => {
    let typed = null
    const t = talk({ store: { links: {} }, notifications: quiet, groups: () => ({ sayToClaude: async (tab, text) => { typed = text; return { ok: true, tab } } }) })
    const r = await t.receiveSay({ tab: 'chat', message: 'hi\x1b[Z\x03\x03 there', from: 'me\x1b' }, { name: 'ROB-SWIFT (computer)' })
    assert.strictEqual(r.status, 200)
    assert.ok(typed.startsWith('[from ROB-SWIFT · "me"] hi'), typed)
    assert.ok(!/[\p{Cc}\p{Cf}]/u.test(typed), JSON.stringify(typed))
})
test('talk refuses without a tabby-groups that limits it to Claude tabs', async () => {
    const t = talk({ store: { links: {} }, notifications: quiet, groups: () => ({ say: async () => ({ ok: true }) }) })
    assert.strictEqual((await t.receiveSay({ tab: 'chat', message: 'hi' }, { name: 'X (computer)' })).status, 501)
})
test('talk never guesses between two computers with one name', async () => {
    const t = talk({ store: { links: { a: { name: 'PC' }, b: { name: 'pc' } } }, notifications: quiet, groups: () => null })
    const r = await t.talkApi.say('PC', 'chat', 'hi')
    assert.ok(!r.ok && /2 linked computers/.test(r.why), r.why)
})
