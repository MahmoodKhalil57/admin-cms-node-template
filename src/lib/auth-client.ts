import { createAuthClient } from 'better-auth/react'

/** Same-origin: each node serves its own `/api/auth/*`. */
export const authClient = createAuthClient({ basePath: '/api/auth' })
