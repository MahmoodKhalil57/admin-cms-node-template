import { useEffect, useState } from 'react'

import { Button } from '#/components/ui/button'
import { Input } from '#/components/ui/input'
import { Textarea } from '#/components/ui/textarea'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '#/components/ui/select'
import { choicesOf } from '#/lib/form-shape'
import type { FormFieldDef } from '#/lib/form-shape'

/**
 * The way out of the profile gate, from inside the panel.
 *
 * The gate refuses every call an unfinished account makes, which includes the
 * calls this panel needs to draw anything. Without this the screen behind would
 * simply be empty and the person would have no way to fix it — the block would
 * be a lockout rather than a question.
 *
 * So the check runs once at mount, against the one endpoint the gate never
 * holds up, and what it finds is put on screen over everything else. No route,
 * no navigation: there is nowhere else to be until this is answered.
 */

interface ProfileForm {
  slug: string
  name: string
  fields: Array<FormFieldDef & { value?: string; readOnly?: true }>
  values: Record<string, unknown>
  requiredAtSignup?: boolean
  complete?: boolean
}

export const ProfileGate = () => {
  const [pending, setPending] = useState<Array<ProfileForm>>([])
  const [answers, setAnswers] = useState<Record<string, unknown>>({})
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    fetch('/api/me/profile')
      .then((response) => (response.ok ? response.json() : { forms: [] }))
      .then((body) => {
        const forms = (body.forms ?? []) as Array<ProfileForm>
        const held = forms.filter((form) => form.requiredAtSignup && !form.complete)
        setPending(held)
        setAnswers(held[0]?.values ?? {})
      })
      // A node with the forms feature off answers 404 here, which is not a
      // reason to put anything on screen.
      .catch(() => setPending([]))
  }, [])

  const form = pending[0]
  if (!form) return null

  const askable = form.fields.filter((field) => !field.readOnly)

  const save = async () => {
    setBusy(true)
    setError(null)
    try {
      const response = await fetch('/api/me/profile', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug: form.slug, values: answers }),
      })
      const body = await response.json().catch(() => ({}))
      if (!response.ok) {
        setError(body.error ?? 'That did not save.')
        return
      }
      const rest = pending.slice(1)
      setPending(rest)
      setAnswers(rest[0]?.values ?? {})
      // The panel booted against a gate that was refusing everything, so its
      // caches hold nothing worth keeping. Reloading is both the simplest way
      // back and the honest one.
      if (rest.length === 0) window.location.reload()
    } finally {
      setBusy(false)
    }
  }

  const set = (name: string, value: unknown) =>
    setAnswers((was) => ({ ...was, [name]: value }))

  const missing = askable.filter(
    (field) => field.required && !String(answers[field.name] ?? '').trim(),
  )

  return (
    <div className="bg-background/95 fixed inset-0 z-50 flex items-center justify-center overflow-y-auto p-4 backdrop-blur-sm">
      <div className="bg-card w-full max-w-lg rounded-xl border p-6 shadow-lg">
        <h2 className="font-display text-xl font-semibold tracking-tight">
          {form.name}
        </h2>
        <p className="text-muted-foreground mt-1 mb-5 text-sm">
          A few details are needed before you can carry on. They are kept on
          your account and you can change them later.
        </p>

        <div className="flex flex-col gap-4">
          {askable.map((field) => (
            <div key={field.name} className="flex flex-col gap-1.5">
              <label
                htmlFor={`profile-${field.name}`}
                className="text-sm font-medium"
              >
                {field.label || field.name}
                {field.required ? (
                  <span className="text-destructive"> *</span>
                ) : null}
              </label>

              {field.type === 'textarea' ? (
                <Textarea
                  id={`profile-${field.name}`}
                  value={String(answers[field.name] ?? '')}
                  placeholder={field.placeholder}
                  onChange={(event) => set(field.name, event.target.value)}
                />
              ) : field.type === 'select' ? (
                <Select
                  value={String(answers[field.name] ?? '')}
                  onValueChange={(next) => set(field.name, next)}
                >
                  <SelectTrigger id={`profile-${field.name}`}>
                    <SelectValue placeholder="Choose" />
                  </SelectTrigger>
                  <SelectContent>
                    {choicesOf(field).map((choice) => (
                      <SelectItem key={choice.value} value={choice.value}>
                        {choice.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <Input
                  id={`profile-${field.name}`}
                  type={field.type === 'number' ? 'number' : field.type}
                  value={String(answers[field.name] ?? '')}
                  placeholder={field.placeholder}
                  onChange={(event) => set(field.name, event.target.value)}
                />
              )}
            </div>
          ))}
        </div>

        {error ? (
          <p className="text-destructive mt-4 text-sm">{error}</p>
        ) : null}

        <div className="mt-6 flex items-center justify-between gap-3">
          <span className="text-muted-foreground text-xs">
            {pending.length > 1 ? `1 of ${pending.length}` : null}
          </span>
          <Button onClick={save} disabled={busy || missing.length > 0}>
            {busy ? 'Saving…' : 'Save and carry on'}
          </Button>
        </div>
      </div>
    </div>
  )
}
