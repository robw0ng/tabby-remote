const crypto = require('crypto')

const sha = s => crypto.createHash('sha256').update(String(s)).digest()

// The password is kept only as a salted scrypt hash.
const hashPassword = (pw, salt = crypto.randomBytes(16).toString('hex')) => `${salt}:${crypto.scryptSync(pw, salt, 32).toString('hex')}`

function passwordMatches (stored, pw) {
    const [salt, hash] = (stored ?? '').split(':')
    return !!hash && crypto.timingSafeEqual(Buffer.from(hashPassword(String(pw ?? ''), salt).split(':')[1], 'hex'), Buffer.from(hash, 'hex'))
}

module.exports = { sha, hashPassword, passwordMatches }
