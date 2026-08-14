import type { NodeDb } from '#/db'
import { events } from '#/db/schema'
import type { Principal } from './authz'

/**
 * Writing down what happened.
 *
 * One rule above all others: **recording must never break the thing it is
 * recording.** An enquiry that arrives and is not logged is a gap in a report.
 * An enquiry that is refused because logging failed is a lost customer. So
 * every failure here is swallowed, and the caller is never told — there is no
 * outcome to handle because there is no decision to make.
 *
 * That is also why it is not awaited on the hot path. `record` returns a
 * promise so a caller *may* wait, but the callers in this codebase do not: the
 * write is fired and the response goes out.
 *
 * What belongs here is decisions. Somebody published a form, somebody's payment
 * cleared, somebody booked Thursday. What does not belong is traffic — a row per
 * request would fill the database with a description of itself, and answer no
 * question anybody asks.
 */

export interface EventInput {
  /** a key from `EVENT_CATALOG` */
  name: string
  /** who did it, when somebody did */
  actor?: Principal | null
  /** what it happened to */
  subjectType?: string
  subjectId?: string | number
  /** whose business it concerns; null until vendors exist */
  vendorId?: number | null
  /** anything worth keeping that is not a column */
  detail?: Record<string, unknown>
}

export async function record(db: NodeDb, event: EventInput): Promise<void> {
  try {
    await db.insert(events).values({
      name: event.name,
      actorUserId: event.actor?.userId ?? null,
      viaKey: Boolean(event.actor?.viaKey),
      vendorId: event.vendorId ?? null,
      subjectType: event.subjectType ?? null,
      subjectId:
        event.subjectId === undefined ? null : String(event.subjectId),
      detail: event.detail ?? {},
    })
  } catch {
    /*
      Deliberately silent.

      There is nothing a caller could usefully do, and anything thrown from here
      would surface as a failure of whatever was being recorded — which is the
      one outcome worse than not recording it.
    */
  }
}

/**
 * The events this node writes, so a dashboard can be built from a list rather
 * than from whatever strings happen to be in the codebase.
 *
 * Named `<subject>.<what happened>`, past tense, matching the automation
 * triggers that already exist — `submission.created` is both a thing that is
 * recorded here and a thing an automation fires on, and they should not be two
 * different spellings of the same moment.
 */
export interface EventDefinition {
  key: string
  area: string
  name: string
  description: string
}

export const EVENT_CATALOG: Array<EventDefinition> = [
  {
    key: 'submission.created',
    area: 'Forms',
    name: 'An enquiry arrived',
    description: 'Somebody sent in a form on the site.',
  },
  {
    key: 'vendor.member_added',
    area: 'Vendors',
    name: 'Somebody was given a vendor',
    description: 'An account was allowed to act for a business.',
  },
  {
    key: 'vendor.member_removed',
    area: 'Vendors',
    name: 'Somebody lost a vendor',
    description: 'An account no longer acts for a business.',
  },
  {
    key: 'order.created',
    area: 'Money',
    name: 'An order was started',
    description: 'Somebody began a checkout. Not yet paid.',
  },
  {
    key: 'order.paid',
    area: 'Money',
    name: 'An order was paid',
    description: 'The provider confirmed the money moved.',
  },
  {
    key: 'order.failed',
    area: 'Money',
    name: 'An order failed',
    description: 'The payment did not go through, or the session expired.',
  },
  {
    key: 'order.refunded',
    area: 'Money',
    name: 'An order was refunded',
    description: 'Money went back, in whole or in part.',
  },
  {
    key: 'resource.created',
    area: 'Panel',
    name: 'Something was created',
    description: 'A form, a rule, a role or a policy was added.',
  },
  {
    key: 'resource.updated',
    area: 'Panel',
    name: 'Something was changed',
    description: 'An existing record was edited.',
  },
  {
    key: 'resource.deleted',
    area: 'Panel',
    name: 'Something was deleted',
    description: 'A record was removed.',
  },
]

export function eventDefinition(key: string): EventDefinition | undefined {
  return EVENT_CATALOG.find((entry) => entry.key === key)
}
