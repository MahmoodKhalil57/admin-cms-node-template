import { createAuthClient } from 'better-auth/react'
import { emailOTPClient } from 'better-auth/client/plugins'

/**
 * Same-origin: each node serves its own `/api/auth/*`.
 *
 * The one-time-code plugin is here because it is how most people on a node sign
 * in. Passwords are the exception — only the account provisioning seeded has
 * one, so that the node is usable before anybody has wired mail up. Everyone
 * invited afterwards gets a code, and without this plugin the client has no
 * method to ask for one.
 */
export const authClient = createAuthClient({
  basePath: '/api/auth',
  plugins: [emailOTPClient()],
})
