// Groups by id, as tabby-groups' list() gives them, without Tabby: npm test
const test = require('node:test')
const assert = require('node:assert')

const { chainOf, findGroup, tryGroups } = require('../lib/groups')

// Two groups called "api", under different parents.
const groups = [
    { id: 'tg-a', name: 'work', path: 'work', parentId: null },
    { id: 'tg-b', name: 'api', path: 'work/api', parentId: 'tg-a' },
    { id: 'tg-c', name: 'home', path: 'home', parentId: null },
    { id: 'tg-d', name: 'api', path: 'home/api', parentId: 'tg-c' },
]

test('a tab\'s chain is walked by id, top first', () => {
    assert.deepStrictEqual(chainOf(groups, 'tg-d').map(g => g.id), ['tg-c', 'tg-d'])
    assert.deepStrictEqual(chainOf(groups, 'tg-x'), [])
})
test('a group is found by id, path or a name only it has', () => {
    assert.strictEqual(findGroup(groups, 'tg-b').group.id, 'tg-b')
    assert.strictEqual(findGroup(groups, 'home/api').group.id, 'tg-d')
    assert.strictEqual(findGroup(groups, 'work').group.id, 'tg-a')
})
test('a name two groups share is refused, an unknown one not found', () => {
    assert.strictEqual(findGroup(groups, 'api').status, 409)
    assert.strictEqual(findGroup(groups, 'nope').status, 404)
})
test('a name shared by a top-level group and a subgroup is refused too, as tabby-groups does', () => {
    const both = [...groups, { id: 'tg-e', name: 'api', path: 'api', parentId: null }]
    assert.strictEqual(findGroup(both, 'api').status, 409)
    assert.strictEqual(findGroup(both, 'tg-e').group.id, 'tg-e')
    assert.strictEqual(findGroup(both, 'work/api').group.id, 'tg-b')
})
test('a tabby-groups throw becomes a 409, not a crash', () => {
    const r = tryGroups(() => { throw new Error('tabby-groups: "api" names 2 groups; give its path') })
    assert.deepStrictEqual(r, { status: 409, error: '"api" names 2 groups; give its path' })
    assert.deepStrictEqual(tryGroups(() => true), { value: true })
})
