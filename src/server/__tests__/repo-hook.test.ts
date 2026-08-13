import { expect, test } from 'bun:test'
import { touches, verifySignature } from '../repo-hook'

const SECRET = 'a-secret-github-was-given'
const BODY = '{"ref":"refs/heads/main","commits":[]}'

async function sign(secret: string, body: string) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const out = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body))
  return 'sha256=' + [...new Uint8Array(out)].map(b => b.toString(16).padStart(2, '0')).join('')
}

test('accepts what GitHub actually signed', async () => {
  expect(await verifySignature(SECRET, BODY, await sign(SECRET, BODY))).toBe(true)
})

test('rejects a different secret, a changed body, and a missing header', async () => {
  expect(await verifySignature(SECRET, BODY, await sign('wrong', BODY))).toBe(false)
  expect(await verifySignature(SECRET, BODY + ' ', await sign(SECRET, BODY))).toBe(false)
  expect(await verifySignature(SECRET, BODY, null)).toBe(false)
  expect(await verifySignature(SECRET, BODY, 'sha256=deadbeef')).toBe(false)
  expect(await verifySignature(SECRET, BODY, 'md5=whatever')).toBe(false)
})

const push = (over: object = {}) => ({
  ref: 'refs/heads/main',
  repository: { default_branch: 'main' },
  commits: [{ modified: ['admin-cms.json'] }],
  ...over,
})

test('acts only on the default branch, and only for this file', () => {
  expect(touches(push(), 'admin-cms.json')).toBe(true)
  expect(touches(push({ ref: 'refs/heads/draft' }), 'admin-cms.json')).toBe(false)
  expect(touches(push({ commits: [{ modified: ['README.md'] }] }), 'admin-cms.json')).toBe(false)
  expect(touches(push({ commits: [{ added: ['admin-cms.json'] }] }), 'admin-cms.json')).toBe(true)
  expect(touches(push({ commits: [{ removed: ['admin-cms.json'] }] }), 'admin-cms.json')).toBe(true)
  expect(touches(push({ commits: [] }), 'admin-cms.json')).toBe(false)
})
