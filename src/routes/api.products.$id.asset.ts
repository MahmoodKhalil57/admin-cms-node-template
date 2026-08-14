import { createFileRoute } from '@tanstack/react-router'
import { eq } from 'drizzle-orm'

import { getDb } from '#/db'
import { productAssets, products } from '#/db/schema'
import { serverRoute } from '#/lib/server-route'
import { getEnv } from '#/server/env'
import { getEnabledFeatures } from '#/server/features'
import { allows, can, forbidden, principalFrom } from '#/server/authz'
import { record } from '#/server/events'

/**
 * The file behind a product.
 *
 * Streamed straight into the node's own R2 bucket — every node has had one
 * since it was provisioned and nothing has used it until now. The body goes
 * past rather than into memory, so the size of what somebody sells is not
 * bounded by what a Worker can hold.
 *
 * The object key is generated here and never shown. A bucket is not a public
 * directory, but a guessable key inside one is a worse thing to depend on than
 * a key nobody can guess.
 */

const MAX_BYTES = 500 * 1024 * 1024

export const Route = createFileRoute('/api/products/$id/asset')(
  serverRoute({
    PUT: async ({ request, params }) => {
      const env = getEnv(request)
      const db = getDb(env)
      if (!(await getEnabledFeatures(db)).includes('payments')) {
        return Response.json({ error: 'Not found' }, { status: 404 })
      }

      const principal = await principalFrom(env, db, request)
      if (!can(principal, 'products:write')) return forbidden('products:write')

      const [product] = await db
        .select()
        .from(products)
        .where(eq(products.id, Number(params.id)))
        .limit(1)
      if (!product) return Response.json({ error: 'Not found' }, { status: 404 })

      // The same narrowing that keeps a vendor to their own listings keeps them
      // to their own files.
      if (!allows(principal, 'products:write', product)) {
        return Response.json({ error: 'Not found' }, { status: 404 })
      }

      const size = Number(request.headers.get('content-length') ?? 0)
      if (size > MAX_BYTES) {
        return Response.json({ error: 'That file is too large.' }, { status: 413 })
      }
      if (!request.body) {
        return Response.json({ error: 'No file.' }, { status: 400 })
      }

      const url = new URL(request.url)
      const filename = (url.searchParams.get('filename') ?? 'download.zip')
        .replace(/[^A-Za-z0-9._-]/g, '_')
        .slice(0, 120)
      const contentType =
        request.headers.get('content-type') ?? 'application/octet-stream'

      const random = [...crypto.getRandomValues(new Uint8Array(12))]
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('')
      const objectKey = `products/${product.id}/${random}/${filename}`

      // The DOM and Workers stream types describe the same object and do not
      // agree about it; the bytes are streamed either way.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await env.MEDIA.put(objectKey, request.body as any, {
        httpMetadata: { contentType },
      })

      // One file per product for now. Replacing it leaves the old object
      // behind rather than deleting it while somebody may be mid-download;
      // sweeping those is a job for later and a cheap one.
      const [existing] = await db
        .select()
        .from(productAssets)
        .where(eq(productAssets.productId, product.id))
        .limit(1)

      const values = {
        productId: product.id,
        filename,
        contentType,
        objectKey,
        size,
      }
      if (existing) {
        await db
          .update(productAssets)
          .set(values)
          .where(eq(productAssets.id, existing.id))
      } else {
        await db.insert(productAssets).values(values)
      }

      await record(db, {
        name: 'product.asset_uploaded',
        actor: principal,
        vendorId: product.vendorId,
        subjectType: 'products',
        subjectId: product.id,
        detail: { filename, size },
      })

      return Response.json({ ok: true, filename, size })
    },
  }),
)
