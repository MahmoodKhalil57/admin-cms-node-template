import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { badSlug, resourceNames } from '../projects/provision'
import { INFRA_SCOPES } from '../infra'
import { CLOUDFLARE_SCOPES } from '../cloudflare-oauth'
import { imageUrl } from '../projects/image'
import type { NodeEnv } from '../env'

/**
 * Projects, built on somebody else's account.
 *
 * The property the whole feature exists to have is a *negative* one — that
 * nothing in this path can reach the platform's Cloudflare account or spend
 * the platform's money — and a negative property is exactly the kind that
 * decays quietly. One convenient import restores the shortcut, everything
 * still works, and the bill moves to the wrong person without a single test
 * going red. So some of these read the source.
 */

const dir = join(import.meta.dir, '../projects')
const source = (name: string) => readFileSync(join(dir, name), 'utf8')

describe('whose account this lands on', () => {
  test('the build is fetched without any credential', () => {
    // The obvious shortcut is reading the artifact out of the platform's R2
    // bucket with the platform's API token, which would put our key inside
    // every provision an operator triggers. It comes from a public release
    // instead, and the absence of an Authorization header is the whole point.
    const code = source('image.ts')
    expect(code).toContain('releases/latest/download')
    // Looking for a header actually being set, not the word — the file talks
    // about *not* sending one, and a naive search finds its own explanation.
    expect(code).not.toMatch(/Bearer/)
    expect(code).not.toMatch(/authorization\s*:/i)
  })

  test('the build URL is public and versionless', () => {
    const env = {} as NodeEnv
    expect(imageUrl(env)).toBe(
      'https://github.com/MahmoodKhalil57/admincms-node-image/releases/latest/download/node-image.json',
    )
  })

  test('provisioning reaches Cloudflare only through the operator’s token', () => {
    /*
      Every call in the project client carries `account.token`, which comes from
      the operator's OAuth grant. Nothing here may reach for the platform's own
      credentials — there is no binding for them on a node, and reintroducing
      one is how layer 3 would quietly start costing us money.
    */
    for (const file of ['cloudflare.ts', 'provision.ts']) {
      const code = source(file)
      expect(code).not.toContain('CLOUDFLARE_API_TOKEN')
      expect(code).not.toContain('PROVISION_TOKEN')
      // The service binding to master is how the node asks the platform to do
      // things on its behalf. Provisioning must never go through it.
      expect(code).not.toContain('env.MASTER')
    }
  })

  test('resources are named from the slug and nothing else', () => {
    // Teardown deletes by derived name only, which is what keeps this away
    // from anything on the operator's account it did not create.
    expect(resourceNames('shop')).toEqual({
      worker: 'p-shop',
      database: 'p-shop',
      kv: 'p-shop-session',
      bucket: 'p-shop-media',
    })
  })
})

describe('the two Cloudflare grants', () => {
  test('are different, and the wider one is not the DNS one', () => {
    // Widening the DNS connection would mean somebody who connected Cloudflare
    // to point a domain had silently granted the ability to create and delete
    // infrastructure. Consent that was never asked for is not consent.
    for (const scope of CLOUDFLARE_SCOPES) {
      expect(INFRA_SCOPES).not.toContain(scope)
    }
  })

  test('the wider one asks for what provisioning actually uses', () => {
    for (const needed of ['d1.write', 'workers_scripts.write', 'workers_kv.write']) {
      expect(INFRA_SCOPES).toContain(needed)
    }
  })

  test('and does not ask for a storage scope, because there is not one', () => {
    // Cloudflare's OAuth vocabulary has no R2 equivalent. Asking for one would
    // not degrade the connection — Cloudflare refuses the *whole*
    // authorization if any requested scope is not on the registration, which
    // is how the DNS connection failed for a fortnight while reporting that
    // the operator had declined.
    expect(INFRA_SCOPES.some((scope) => scope.startsWith('r2'))).toBe(false)
  })
})

describe('naming a project', () => {
  test('accepts the ordinary ones', () => {
    for (const good of ['shop', 'my-project', 'a1', 'ab', 'x'.repeat(32)]) {
      expect(badSlug(good)).toBeNull()
    }
  })

  test('refuses what would make an unusable resource name', () => {
    for (const bad of ['A', 'x', '-leading', 'trailing-', 'has space', 'x'.repeat(33), '']) {
      // 'x' is in here on purpose: one character is not enough, which is what
      // the message says and what the first regex accidentally allowed.
      expect(badSlug(bad)).not.toBeNull()
    }
  })
})
