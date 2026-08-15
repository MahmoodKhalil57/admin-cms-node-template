import type { NodeEnv } from './env'

/**
 * The node's side of being billed.
 *
 * A thin pass-through, and deliberately so. The operator of this node has an
 * account here and nowhere else — they have never seen master and should not
 * have to — so the node asks on their behalf over the service binding it
 * already uses for mail and usage.
 *
 * **No money passes through here.** Master owns the customer, the card, the
 * webhook and the ledger; this fetches a number and a URL. The node cannot
 * grant itself credits, which is the property that makes it safe for the thing
 * being billed to be the thing displaying the bill.
 */

export interface BillingView {
  configured: boolean
  balance: { purchased: number; used: number; balance: number }
  packages: Array<{
    key: string
    name: string
    description: string | null
    credits: number
    price: number
    currency: string
    monthly: boolean
  }>
  subscription: {
    packageKey: string
    status: string
    currentPeriodEnd: string | null
  } | null
}

async function ask(
  env: NodeEnv,
  body: Record<string, unknown>,
): Promise<Response | null> {
  if (!env.MASTER || !env.PROVISION_TOKEN) return null
  return env.MASTER.fetch('https://master/api/internal/billing', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.PROVISION_TOKEN}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ slug: env.NODE_ID, ...body }),
  })
}

export async function billingView(
  env: NodeEnv,
): Promise<BillingView | { error: string }> {
  const response = await ask(env, {})
  if (!response) return { error: 'This node cannot reach the platform.' }
  const body = (await response.json().catch(() => ({}))) as BillingView & {
    error?: string
  }
  if (!response.ok) return { error: body.error ?? 'The platform did not answer.' }
  return body
}

export async function startCheckout(
  env: NodeEnv,
  packageKey: string,
  returnTo: string,
): Promise<{ url: string } | { error: string }> {
  const response = await ask(env, { packageKey, returnTo })
  if (!response) return { error: 'This node cannot reach the platform.' }
  const body = (await response.json().catch(() => ({}))) as {
    url?: string
    error?: string
  }
  if (!response.ok || !body.url) {
    return { error: body.error ?? 'Checkout could not be started.' }
  }
  return { url: body.url }
}
