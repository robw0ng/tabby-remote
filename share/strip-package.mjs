// Keeps what Tabby needs from package.json (name, version, keywords, author, main, dependencies) and drops the rest,
// such as the private repo's link. Usage: node strip-package.mjs <package.json>
import { readFileSync, writeFileSync } from 'fs'

const file = process.argv[2]
const pkg = JSON.parse(readFileSync(file, 'utf8'))
const keep = ['name', 'version', 'description', 'keywords', 'author', 'license', 'main', 'dependencies']
writeFileSync(file, JSON.stringify(Object.fromEntries(keep.filter(k => k in pkg).map(k => [k, pkg[k]])), null, 2) + '\n')
