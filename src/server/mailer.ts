import type { NodeEnv } from './env'

/**
 * Sending mail, through the platform.
 *
 * The node never holds a mail credential. Cloudflare's send API is
 * account-scoped, so the token that reaches it can send as any tenant — which
 * is precisely why it stays with master. The node asks over the service binding
 * it already has, proving who it is with the token provisioning derived.
 *
 * Every caller here treats sending as best-effort. A message that does not go
 * must never fail the thing it was announcing: an invitation still exists as a
 * link, and a reset that could not be mailed is better reported than thrown.
 */

export interface Mail {
  to: string
  subject: string
  text: string
  html: string
}

export interface SendOutcome {
  sent: boolean
  /** the address it came from, worth showing so the operator can vouch for it */
  from?: string
  reason?: string
}

export async function sendMail(
  env: NodeEnv,
  mail: Mail,
  /**
   * Which hostname to send as. The node's custom domain when it has one — that
   * is the address its people recognise — and the provisioned origin otherwise.
   */
  hostname?: string | null,
): Promise<SendOutcome> {
  if (!env.MASTER || !env.PROVISION_TOKEN) {
    return { sent: false, reason: 'This node cannot reach the platform.' }
  }

  try {
    const response = await env.MASTER.fetch(
      'https://master/api/internal/send',
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${env.PROVISION_TOKEN}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          slug: env.NODE_ID,
          // Master decides the sender; this only says which hostname to prefer.
          hostname: hostname || env.ORIGIN_HOST || undefined,
          ...mail,
        }),
      },
    )
    const body = (await response.json().catch(() => ({}))) as {
      ok?: boolean
      from?: string
      error?: string
      note?: string
    }
    if (!response.ok || !body.ok) {
      return { sent: false, reason: body.error ?? body.note ?? 'Mail was refused.' }
    }
    return { sent: true, from: body.from }
  } catch (error) {
    return {
      sent: false,
      reason: error instanceof Error ? error.message : String(error),
    }
  }
}

function escape(value: string): string {
  return value.replace(
    /[&<>"]/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[
        character
      ] as string,
  )
}

/**
 * Both messages carry a plain-text part.
 *
 * A transactional mail that renders as an empty box in a text-only client is a
 * mail that did not arrive, and these two are the ones that must.
 */
function layout(lead: string, action: string, url: string, footer: string) {
  return `<!doctype html><html><body style="margin:0;padding:24px;background:#f0f7f3;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#12333a">
<table role="presentation" cellpadding="0" cellspacing="0" style="max-width:520px;margin:0 auto;background:#fff;border:1px solid rgba(23,58,64,.13);border-radius:12px">
<tr><td style="padding:28px">
<p style="margin:0 0 18px;font-size:15px;line-height:1.55">${lead}</p>
<p style="margin:0 0 22px"><a href="${escape(url)}" style="display:inline-block;padding:11px 20px;background:#16626a;color:#f2fbfa;text-decoration:none;border-radius:8px;font-size:14px;font-weight:600">${escape(action)}</a></p>
<p style="margin:0 0 6px;font-size:12px;color:#4e737a">Or paste this into your browser:</p>
<p style="margin:0 0 20px;font-size:12px;word-break:break-all"><a href="${escape(url)}" style="color:#16626a">${escape(url)}</a></p>
<p style="margin:0;font-size:12px;line-height:1.5;color:#4e737a">${escape(footer)}</p>
</td></tr></table></body></html>`
}

export function invitationMail(options: {
  to: string
  url: string
  invitedBy: string | null
  workspace: string
}): Mail {
  const who = options.invitedBy ? ` by ${options.invitedBy}` : ''
  return {
    to: options.to,
    subject: `You have been invited to ${options.workspace}`,
    text: `You have been invited${who} to help run ${options.workspace}.

Open this to choose a password:
${options.url}

It works once and expires in seven days. If you were not expecting it, ignore it — nothing happens until it is opened.`,
    html: layout(
      `You have been invited${escape(who)} to help run <strong>${escape(options.workspace)}</strong>.`,
      'Choose a password',
      options.url,
      'It works once and expires in seven days. If you were not expecting it, ignore it — nothing happens until it is opened.',
    ),
  }
}

export function resetMail(options: {
  to: string
  url: string
  workspace: string
}): Mail {
  return {
    to: options.to,
    subject: `Reset your ${options.workspace} password`,
    text: `Someone asked to reset the password for your ${options.workspace} account.

Open this to set a new one:
${options.url}

It expires in an hour. If this was not you, ignore it — your password stays as it is.`,
    html: layout(
      `Someone asked to reset the password for your <strong>${escape(options.workspace)}</strong> account.`,
      'Set a new password',
      options.url,
      'It expires in an hour. If this was not you, ignore it — your password stays as it is.',
    ),
  }
}
