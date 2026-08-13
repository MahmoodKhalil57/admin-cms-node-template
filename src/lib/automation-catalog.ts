/**
 * What can set off an automation, and how someone can be told.
 *
 * Code is the catalog and rows are the state, the same way features,
 * permissions and templates work here. A business decides *that* the wholesale
 * enquiries should reach the trade desk; it cannot invent a new kind of event
 * or a new delivery channel, because those need code behind them.
 *
 * The shape is deliberately three separate questions, because they change
 * independently:
 *
 *   when   — which event, and on which records (a condition)
 *   who    — an audience, resolved at the moment it fires
 *   how    — one or more channels
 *
 * Channels are listed here before they exist so the model is not reshaped later
 * to fit them. An automation that names `sms` today is stored, shown as not yet
 * available, and starts working when the channel does — rather than the whole
 * table needing a migration when it lands.
 */

export interface TriggerDefinition {
  key: string
  name: string
  description: string
  /** the feature that supplies this event */
  feature: string
  /**
   * Fields a condition can test. These are the record's own columns; a form's
   * answers are addressed as `data.<field>` and offered separately, because
   * which ones exist depends on the form.
   */
  fields: Array<{ field: string; label: string }>
}

export const TRIGGER_CATALOG: Array<TriggerDefinition> = [
  {
    key: 'submission.created',
    name: 'A form is submitted',
    description: 'Fires the moment a visitor sends a form in.',
    feature: 'forms',
    fields: [{ field: 'formId', label: 'Which form' }],
  },
]

export interface ChannelDefinition {
  key: string
  name: string
  description: string
  /** false while the channel is planned but not built */
  available: boolean
  /** what an audience member needs before this channel can reach them */
  needs: string
}

export const CHANNEL_CATALOG: Array<ChannelDefinition> = [
  {
    key: 'email',
    name: 'Email',
    description: 'Sent from this node’s own address.',
    available: true,
    needs: 'an email address',
  },
  {
    key: 'sms',
    name: 'SMS',
    description: 'Not built yet. Automations can name it now and will start using it when it lands.',
    available: false,
    needs: 'a phone number',
  },
  {
    key: 'in-app',
    name: 'In the panel',
    description:
      'Not built yet. Every send is already recorded, so this becomes a read of that record rather than new plumbing.',
    available: false,
    needs: 'an account on this node',
  },
]

/**
 * Who gets told.
 *
 * Three kinds, because businesses describe the same audience three different
 * ways and each survives a different kind of change:
 *
 *   people   — this person. Breaks when they leave.
 *   roles    — whoever holds this job. Survives the person changing.
 *   policies — whoever is allowed to deal with this record. Survives the
 *              org chart changing, and is the only one that narrows per record:
 *              a desk scoped to one form is told about that form only.
 */
export type AudienceKind = 'people' | 'roles' | 'policies' | 'addresses'

export interface Audience {
  /** better-auth user ids */
  people?: Array<string>
  /** role keys */
  roles?: Array<string>
  /** permission keys — whoever holds one, respecting how it is narrowed */
  policies?: Array<string>
  /** literal addresses, for people who have no account here */
  addresses?: Array<string>
}

export function triggerFor(key: string): TriggerDefinition | undefined {
  return TRIGGER_CATALOG.find((trigger) => trigger.key === key)
}

export function channelFor(key: string): ChannelDefinition | undefined {
  return CHANNEL_CATALOG.find((channel) => channel.key === key)
}

export function triggersFor(
  enabledFeatures: Array<string>,
): Array<TriggerDefinition> {
  return TRIGGER_CATALOG.filter((trigger) =>
    enabledFeatures.includes(trigger.feature),
  )
}
