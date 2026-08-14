import type { NodeDb } from '#/db'
import { RESOURCE_PERMISSIONS, definitionOf } from '#/lib/permission-catalog'
import {
  createResource,
  deleteResource,
  getResource,
  listResource,
  reachable,
  updateResource,
} from '#/lib/rest'
import type { Principal } from './authz'
import { allowedWays, can, deniedWays } from './authz'

/**
 * This node, as a set of tools an agent can discover.
 *
 * The whole design is one idea: an agent holding a key should be able to ask
 * what it can do, and get an answer that is already true. Not a catalogue with
 * a warning attached — a list where everything listed works and nothing missing
 * would have.
 *
 * So the tool list is not a constant. It is computed from the key that asked,
 * through exactly the grant every other gate reads, and it calls exactly the
 * REST handlers the panel calls. There is no second permission system, no
 * second set of routes, and nothing to keep in step: a policy written for a
 * person applies unchanged to an agent, and a permission added to the node
 * appears as a tool the same afternoon.
 *
 * Which is what makes an "AI agent" role safe to set up. The footgun in
 * designing a role for an agent is granting something whose consequences you
 * did not picture; here the person minting the key sees the tools it will have
 * before they hand it over, because the list is derived from the same rules
 * rather than described alongside them.
 *
 * Stateless on purpose. Every request carries its key, resolves its own
 * principal and answers on its own — no session to establish, nothing kept
 * between calls, and a node that can be reached from anywhere an agent runs.
 */

export const PROTOCOL_VERSION = '2026-07-28'
const SERVER_NAME = 'admin-cms-node'

/* --- JSON-RPC ------------------------------------------------------------- */

export interface RpcRequest {
  jsonrpc: '2.0'
  id?: string | number | null
  method: string
  params?: Record<string, unknown>
}

const CODES = {
  parse: -32700,
  invalid: -32600,
  noMethod: -32601,
  badParams: -32602,
  internal: -32603,
}

export function rpcResult(id: RpcRequest['id'], result: unknown) {
  return { jsonrpc: '2.0' as const, id: id ?? null, result }
}

export function rpcError(id: RpcRequest['id'], code: number, message: string) {
  return { jsonrpc: '2.0' as const, id: id ?? null, error: { code, message } }
}

/* --- the tools ------------------------------------------------------------ */

/** Resources an agent may address, with the words a model needs to choose. */
const SUBJECTS: Record<
  string,
  { singular: string; plural: string; about: string }
> = {
  forms: {
    singular: 'form',
    plural: 'forms',
    about: 'A form this node serves: its fields, its slug and whether it is published.',
  },
  submissions: {
    singular: 'submission',
    plural: 'submissions',
    about:
      'Something a visitor sent in through a form. `data` holds their answers keyed by field name.',
  },
  automations: {
    singular: 'notification rule',
    plural: 'notification rules',
    about: 'When something happens, who gets told and how.',
  },
  notifications: {
    singular: 'sent message',
    plural: 'sent messages',
    about: 'One attempt to tell somebody something, and whether it worked.',
  },
  roles: {
    singular: 'role',
    plural: 'roles',
    about: 'A kind of access, and the policies it carries.',
  },
  policies: {
    singular: 'policy',
    plural: 'policies',
    about: 'One rule about records, attachable to roles. A refusal beats every grant.',
  },
  invitations: {
    singular: 'invitation',
    plural: 'invitations',
    about: 'An outstanding invitation to join this node.',
  },
  features: {
    singular: 'feature',
    plural: 'features',
    about: 'Whether one of this node’s capabilities is switched on.',
  },
}

interface McpTool {
  name: string
  title: string
  description: string
  inputSchema: { type: 'object'; [key: string]: unknown }
  annotations: Record<string, unknown>
}

/**
 * Says, in the tool's own description, what this key may actually reach.
 *
 * An agent that knows it can only see two forms asks differently from one that
 * believes it can see all of them, and it does not spend three calls finding
 * out. The narrowing is already applied by the time any row comes back; this
 * only makes it legible.
 */
function narrowingNote(principal: Principal, permission: string): string {
  const groups = allowedWays(principal, permission)
  const denials = deniedWays(principal, permission)
  const notes: Array<string> = []

  for (const group of groups) {
    const parts = group.map((way) =>
      Object.entries(way)
        .map(([field, rule]) => {
          if (rule.self) return `${field} is your own`
          if (rule.eq !== undefined) return `${field} is ${rule.eq}`
          if (rule.in) return `${field} is one of ${rule.in.join(', ')}`
          return field
        })
        .join(' and '),
    )
    if (parts.length) notes.push(parts.join(' or '))
  }
  for (const refusal of denials) {
    const said = Object.entries(refusal)
      .map(([field, rule]) =>
        rule.in ? `${field} is one of ${rule.in.join(', ')}` : field,
      )
      .join(' and ')
    if (said) notes.push(`never where ${said}`)
  }

  if (!notes.length) return ''
  return ` Limited to records where ${notes.join('; and where ')}.`
}

const ID_SCHEMA = {
  type: 'object',
  properties: { id: { type: 'string', description: 'The record’s id.' } },
  required: ['id'],
  additionalProperties: false,
} as const

/**
 * Every tool this principal can actually use.
 *
 * Built from the same table the REST layer routes on and the same permission
 * map it guards with, so a resource cannot appear here that the handler would
 * refuse, and cannot be missing here if the handler would allow it.
 */
export function toolsFor(
  principal: Principal,
  features: Array<string>,
): Array<McpTool> {
  const tools: Array<McpTool> = []

  for (const [resource, permissions] of Object.entries(RESOURCE_PERMISSIONS)) {
    const subject = SUBJECTS[resource]
    if (!subject) continue

    // The catalog knows which feature a permission belongs to; a node with that
    // feature off must not advertise the tool.
    const definition = definitionOf(permissions.read)
    if (definition?.feature && !features.includes(definition.feature)) continue

    /** Held, and able to reach something here. Both, or it is not offered. */
    const offers = (permission: string) =>
      can(principal, permission) &&
      reachable(resource, features, principal, permission)

    if (offers(permissions.read)) {
      const note = narrowingNote(principal, permissions.read)
      tools.push({
        name: `list_${resource}`,
        title: `List ${subject.plural}`,
        description: `${subject.about} Returns a page of them, newest first.${note}`,
        inputSchema: {
          type: 'object',
          properties: {
            page: { type: 'integer', minimum: 1, default: 1 },
            per_page: { type: 'integer', minimum: 1, maximum: 100, default: 25 },
            filter: {
              type: 'object',
              description:
                'Exact matches by column, e.g. {"formId": 3}. Unknown columns are ignored.',
              additionalProperties: true,
            },
          },
          additionalProperties: false,
        },
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      })
      tools.push({
        name: `get_${resource}`,
        title: `Get one ${subject.singular}`,
        description: `${subject.about} Fetches one by id.${note}`,
        inputSchema: ID_SCHEMA as unknown as McpTool['inputSchema'],
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      })
    }

    if (offers(permissions.write)) {
      const note = narrowingNote(principal, permissions.write)
      tools.push({
        name: `create_${resource}`,
        title: `Create a ${subject.singular}`,
        description: `Creates one ${subject.singular}. ${subject.about}${note}`,
        inputSchema: {
          type: 'object',
          properties: {
            values: {
              type: 'object',
              description: 'The record’s columns and their values.',
              additionalProperties: true,
            },
          },
          required: ['values'],
          additionalProperties: false,
        },
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      })
      tools.push({
        name: `update_${resource}`,
        title: `Update a ${subject.singular}`,
        description: `Changes one ${subject.singular} by id.${note}`,
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'The record’s id.' },
            values: {
              type: 'object',
              description: 'Only the columns to change.',
              additionalProperties: true,
            },
          },
          required: ['id', 'values'],
          additionalProperties: false,
        },
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      })
    }

    if (permissions.delete && offers(permissions.delete)) {
      tools.push({
        name: `delete_${resource}`,
        title: `Delete a ${subject.singular}`,
        description: `Removes one ${subject.singular} by id. This cannot be undone.${narrowingNote(
          principal,
          permissions.delete,
        )}`,
        inputSchema: ID_SCHEMA as unknown as McpTool['inputSchema'],
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: true,
          openWorldHint: false,
        },
      })
    }
  }

  // Always available, and the natural first call: an agent that can ask who it
  // is does not have to guess from the tool list alone.
  tools.push({
    name: 'whoami',
    title: 'Who this key acts as',
    description:
      'The account this key belongs to, the role it carries, and every permission it holds after both gates. Useful as a first call.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  })

  return tools
}

/* --- calling them --------------------------------------------------------- */

const CALL = /^(list|get|create|update|delete)_(.+)$/

interface CallOutcome {
  content: Array<{ type: 'text'; text: string }>
  structuredContent?: unknown
  isError?: boolean
}

function said(value: unknown, isError = false): CallOutcome {
  return {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
    ...(isError ? { isError: true } : {}),
  }
}

/**
 * Runs a tool by calling the REST handler behind it.
 *
 * Deliberately through the handlers rather than the database. Every rule those
 * handlers apply — the resource allowlist, the feature gate, the permission
 * check, the WHERE clause the grant narrows to, the check on a write's own
 * record — applies here without being restated, because it is not being
 * restated. It is the same code.
 *
 * A refusal comes back as a result with `isError`, not a protocol error, so the
 * model can read what happened and choose something else.
 */
export async function callTool(
  db: NodeDb,
  features: Array<string>,
  principal: Principal,
  name: string,
  args: Record<string, unknown>,
): Promise<CallOutcome> {
  if (name === 'whoami') {
    return said({
      email: principal.email,
      role: principal.roleKey,
      is_root_admin: principal.isOwner,
      acting_via_key: principal.viaKey,
      permissions: principal.permissions,
      narrowed: Object.fromEntries(
        principal.permissions
          .map((key) => [key, narrowingNote(principal, key).trim()])
          .filter(([, note]) => note),
      ),
    })
  }

  const match = CALL.exec(name)
  if (!match) {
    return said({ error: `There is no tool called ${name}.` }, true)
  }
  const [, verb, resource] = match as unknown as [string, string, string]

  // The tool list is built from this principal, so a name outside it is a name
  // this key was never offered — refused rather than attempted.
  if (!toolsFor(principal, features).some((tool) => tool.name === name)) {
    return said(
      { error: `This key cannot use ${name}. Call tools/list to see what it can.` },
      true,
    )
  }

  const base = 'https://node.invalid'
  let response: Response

  switch (verb) {
    case 'list': {
      const url = new URL(`${base}/api/${resource}`)
      const page = Number(args.page ?? 1)
      const perPage = Math.min(Number(args.per_page ?? 25), 100)
      url.searchParams.set(
        'range',
        JSON.stringify([(page - 1) * perPage, page * perPage - 1]),
      )
      url.searchParams.set('sort', JSON.stringify(['id', 'DESC']))
      if (args.filter) url.searchParams.set('filter', JSON.stringify(args.filter))
      response = await listResource(db, features, resource, url, principal)
      break
    }
    case 'get':
      response = await getResource(db, features, resource, String(args.id), principal)
      break
    case 'create':
      response = await createResource(
        db,
        features,
        resource,
        jsonRequest(args.values),
        principal,
      )
      break
    case 'update':
      response = await updateResource(
        db,
        features,
        resource,
        String(args.id),
        jsonRequest(args.values),
        principal,
      )
      break
    case 'delete':
      response = await deleteResource(
        db,
        features,
        resource,
        String(args.id),
        principal,
      )
      break
    default:
      return said({ error: `There is no tool called ${name}.` }, true)
  }

  const body = await response.json().catch(() => null)
  return said(body, !response.ok)
}

function jsonRequest(values: unknown): Request {
  return new Request('https://node.invalid', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(values ?? {}),
  })
}

/* --- the protocol --------------------------------------------------------- */

export async function handleRpc(
  db: NodeDb,
  features: Array<string>,
  principal: Principal,
  message: RpcRequest,
): Promise<unknown | null> {
  const { method, id } = message

  switch (method) {
    case 'initialize':
      return rpcResult(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {
          // Nothing is kept between calls, so nothing here can change under a
          // client — no list-changed notifications to promise.
          tools: { listChanged: false },
        },
        serverInfo: {
          name: SERVER_NAME,
          title: 'Admin CMS node',
          version: '1.0.0',
        },
        instructions:
          'The tools you can see are the ones this key may use; the list is derived from its permissions, so anything listed will work. Call whoami first to learn which account you are acting as and how its access is narrowed.',
      })

    // Notifications carry no id and get no reply.
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return null

    case 'ping':
      return rpcResult(id, {})

    case 'tools/list':
      return rpcResult(id, { tools: toolsFor(principal, features) })

    case 'tools/call': {
      const params = (message.params ?? {}) as {
        name?: string
        arguments?: Record<string, unknown>
      }
      if (!params.name) {
        return rpcError(id, CODES.badParams, 'A tool name is required.')
      }
      return rpcResult(
        id,
        await callTool(db, features, principal, params.name, params.arguments ?? {}),
      )
    }

    // Declared unsupported rather than left to fail: a client that asks is
    // told once, in the shape it expects.
    case 'resources/list':
    case 'prompts/list':
      return rpcError(id, CODES.noMethod, `This node does not offer ${method}.`)

    default:
      return rpcError(id, CODES.noMethod, `Unknown method ${method}.`)
  }
}

export const RPC_CODES = CODES
