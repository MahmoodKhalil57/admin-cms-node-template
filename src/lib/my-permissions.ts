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
}

let pending: Promise<MyPermissions> | null = null

export function loadMyPermissions(): Promise<MyPermissions> {
  if (!pending) {
    pending = fetch('/api/permissions')
      .then((response) =>
        response.ok ? response.json() : { mine: [], isOwner: false, roleKey: null },
      )
      .then((body: Partial<MyPermissions>) => ({
        mine: body.mine ?? [],
        isOwner: body.isOwner ?? false,
        roleKey: body.roleKey ?? null,
      }))
      .catch(() => ({ mine: [], isOwner: false, roleKey: null }))
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
  return permissions.isOwner || permissions.mine.includes(key)
}
