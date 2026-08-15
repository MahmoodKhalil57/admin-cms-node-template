import { useLogin, useNotify } from 'ra-core'
import { useState } from 'react'

import { Button } from '#/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '#/components/ui/card'
import { Input } from '#/components/ui/input'
import { Label } from '#/components/ui/label'
import { authClient } from '#/lib/auth-client'

/**
 * Signing in.
 *
 * **A code is the ordinary way in, and a password is the exception**, which is
 * the opposite of what most sign-in screens assume — so this one leads with the
 * code. Only the account provisioning seeded has a password at all, because a
 * node has to be usable before anybody has wired mail up. Everybody invited
 * afterwards gets six digits in their inbox.
 *
 * Before this, the screen offered a password field to everyone and the server
 * refused it for all but one person, with a 400 and no way forward. Somebody
 * invited to a node could accept the invitation, arrive here, and have no path
 * in at all — the flow that existed was the one almost nobody could use.
 *
 * Deliberately offers no way to register: accounts are seeded or invited, and
 * the sign-up endpoint is disabled server-side.
 */

type Step = 'email' | 'code' | 'password'

export const LoginPage = ({
  title = 'adminCms',
  subtitle = 'Control plane',
}: {
  title?: string
  subtitle?: string
}) => {
  const login = useLogin()
  const notify = useNotify()
  const [step, setStep] = useState<Step>('email')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)

  const sendCode = async () => {
    if (!email.trim()) return
    setBusy(true)
    try {
      const { error } = await authClient.emailOtp.sendVerificationOtp({
        email: email.trim(),
        type: 'sign-in',
      })
      if (error) {
        notify(error.message ?? 'Could not send a code.', { type: 'error' })
        return
      }
      setStep('code')
      notify('Check your email for a six-digit code.', { type: 'info' })
    } catch (error) {
      notify(
        error instanceof Error ? error.message : 'Could not send a code.',
        { type: 'error' },
      )
    } finally {
      // In a `finally` because without one a thrown request leaves the button
      // saying "Working…" for as long as the person is willing to wait.
      setBusy(false)
    }
  }

  const signIn = async (credentials: Record<string, string>) => {
    setBusy(true)
    try {
      await login(credentials)
    } catch (error) {
      const said = error instanceof Error ? error.message : 'Could not sign in.'
      /*
        The refusal that used to be a dead end.

        A node only lets its seeded owner use a password; everyone else is told
        to use a code. Rather than reporting that and leaving them on a form
        that will never work, take them to the one that will.
      */
      if (said.toLowerCase().includes('code we email')) {
        setStep('email')
        notify('This account signs in with a code. Send yourself one.', {
          type: 'info',
        })
      } else {
        notify(said, { type: 'error' })
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="bg-muted flex min-h-screen items-center justify-center p-6">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>{title}</CardTitle>
          <p className="text-muted-foreground text-sm">{subtitle}</p>
        </CardHeader>
        <CardContent>
          <form
            className="flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault()
              if (step === 'email') void sendCode()
              else if (step === 'code') void signIn({ email, otp: code })
              else void signIn({ email, password })
            }}
          >
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                autoComplete="username"
                required
                autoFocus
                value={email}
                // Changing the address invalidates a code sent to the old one,
                // so the step goes back rather than leaving a stale field.
                onChange={(event) => {
                  setEmail(event.target.value)
                  if (step === 'code') setStep('email')
                }}
              />
            </div>

            {step === 'code' ? (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="code">Code</Label>
                <Input
                  id="code"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  placeholder="123456"
                  required
                  autoFocus
                  className="font-mono tracking-[0.3em]"
                  value={code}
                  onChange={(event) => setCode(event.target.value.trim())}
                />
                <p className="text-muted-foreground text-xs">
                  Sent to {email}. It expires in ten minutes.
                </p>
              </div>
            ) : null}

            {step === 'password' ? (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="password">Password</Label>
                <Input
                  id="password"
                  type="password"
                  autoComplete="current-password"
                  required
                  autoFocus
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                />
              </div>
            ) : null}

            <Button type="submit" disabled={busy}>
              {busy
                ? 'Working…'
                : step === 'email'
                  ? 'Email me a code'
                  : 'Sign in'}
            </Button>
          </form>

          <div className="mt-4 flex flex-col gap-2 text-center text-sm">
            {step === 'code' ? (
              <button
                type="button"
                className="text-muted-foreground hover:text-foreground underline"
                onClick={() => void sendCode()}
                disabled={busy}
              >
                Send another code
              </button>
            ) : null}

            {step === 'password' ? (
              <button
                type="button"
                className="text-muted-foreground hover:text-foreground underline"
                onClick={() => setStep('email')}
              >
                Sign in with a code instead
              </button>
            ) : (
              /* Kept quiet and last. It is the right door for exactly one
                 account on this node, and offering it first sends everybody
                 else to a form that will refuse them. */
              <button
                type="button"
                className="text-muted-foreground hover:text-foreground underline"
                onClick={() => setStep('password')}
              >
                I have a password
              </button>
            )}

            {step === 'password' ? (
              <a
                href="/admin/forgot"
                className="text-muted-foreground hover:text-foreground underline"
              >
                Forgotten your password?
              </a>
            ) : null}
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
