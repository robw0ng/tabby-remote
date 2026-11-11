// tabby-groups' groups as its list() gives them: a hidden id, a name unique only among siblings, a path ("a/b") and
// the parent's id. No Tabby here, so the tests can use it.

/** The groups from the top one down to `id`. */
function chainOf (groups, id) {
    const out = []
    for (let g = groups.find(x => x.id === id); g && out.length <= groups.length; g = groups.find(x => x.id === g.parentId)) out.unshift(g)
    return out
}

/** The group `ref` names, in tabby-groups' own order: an id, else a name only one group has (one that two groups
 *  share is refused, even when one of them is at the top), else a path. { group } or { status, error }. */
function findGroup (groups, ref) {
    const byId = groups.find(x => x.id === ref)
    if (byId) return { group: byId }
    const named = groups.filter(x => x.name === ref)
    if (named.length > 1) return { status: 409, error: `"${ref}" names ${named.length} groups; give its id or path` }
    const g = named[0] ?? groups.find(x => x.path === ref)
    return g ? { group: g } : { status: 404, error: 'no such group' }
}

/** A tabby-groups call, whose throw (a name two groups share, a group put inside itself) becomes { status: 409, error }. */
function tryGroups (f) {
    try {
        return { value: f() }
    } catch (e) {
        return { status: 409, error: String(e?.message ?? e).replace(/^tabby-groups: /, '') }
    }
}

module.exports = { chainOf, findGroup, tryGroups }
