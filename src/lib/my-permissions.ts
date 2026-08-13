import { useEffect, useState } from 'react'

/**
 * What the signed-in person may do here.
 *
 * The panel needs this to decide which screens exist at all. It is a
 * convenience, not a control: every one of these permissions is checked again
 * on the server, because hiding a screen only hides it.
 */
export interface MyPermissions {
  mine: Array<string>
  isOwner: boolean
  roleKey: string | null
  /**
   * Whether anyone is signed in. Signed out there is nothing to filter by, and
   * filtering anyway leaves `<Admin>` with no children at all — which renders
   * the kit's "ready" splash instead of the login form.
   */
  authed: boolean
}

let pending: Promise<MyPermissions> | null = null

export function loadMyPermissions(): Promise<MyPermissions> {
  if (!pending) {
    pending = fetch('/api/permissions')
      .then(async (response) =>
        response.ok
          ? { ...((await response.json()) as Partial<MyPermissions>), authed: true }
          : { mine: [], isOwner: false, roleKey: null, authed: false },
      )
      .then((body) => ({
        mine: body.mine ?? [],
        isOwner: body.isOwner ?? false,
        roleKey: body.roleKey ?? null,
        authed: body.authed ?? false,
      }))
      .catch(() => ({
        mine: [],
        isOwner: false,
        roleKey: null,
        authed: false,
      }))
  }
  return pending
}

export function forgetMyPermissions() {
  pending = null
}

export function useMyPermissions(): MyPermissions | null {
  const [mine, setMine] = useState<MyPermissions | null>(null)
  useEffect(() => {
    let cancelled = false
    loadMyPermissions().then((result) => {
      if (!cancelled) setMine(result)
    })
    return () => {
      cancelled = true
    }
  }, [])
  return mine
}

export function holds(
  permissions: MyPermissions | null,
  key: string,
): boolean {
  if (!permissions) return false
  // Signed out, everything is offered and nothing is reachable: `requireAuth`
  // shows the login form, and the API refuses regardless.
  if (!permissions.authed) return true
  return permissions.isOwner || permissions.mine.includes(key)
}
