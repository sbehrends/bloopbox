'use client'

import { type FormEvent, useEffect, useState } from 'react'

import { waitlist } from '@/lib/site'

import styles from './WaitlistForm.module.css'

type Status = 'idle' | 'sending' | 'done' | 'failed'

/** Posts to HubSpot's Forms submission API as JSON, so this needs JavaScript. Copy must never imply the device is buyable (see `website/README.md`). */
export function WaitlistForm() {
  const [hydrated, setHydrated] = useState(false)
  const [status, setStatus] = useState<Status>('idle')

  useEffect(() => setHydrated(true), [])

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const data = new FormData(event.currentTarget)

    // A filled trap is a bot. Tell it what it wants to hear and send nothing.
    if (data.get('_gotcha')) {
      setStatus('done')
      return
    }

    setStatus('sending')
    try {
      const response = await fetch(waitlist.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // HubSpot rejects any field the form does not define, so only `email` goes in `fields`.
        // The page it came from rides in `context` and shows on the contact as the conversion page.
        body: JSON.stringify({
          fields: [{ objectTypeId: '0-1', name: 'email', value: data.get('email') }],
          context: { pageUri: window.location.href, pageName: document.title },
        }),
      })
      setStatus(response.ok ? 'done' : 'failed')
    } catch {
      setStatus('failed')
    }
  }

  return (
    <section className={styles.panel} aria-labelledby="kit-title">
      <h2 className={styles.title} id="kit-title">
        Or don’t build it at all.
      </h2>

      <p className={styles.body}>
        Everything below is doable in an afternoon with dedication, basic tooling and the right parts.
        If you would rather have one arrive in a box with the parts already talking to each other, leave your email and
        we will tell you if that ever becomes a thing you can actually get.
      </p>

      {status === 'done' ? (
        <p className={styles.done} role="status">
          Got it. If a kit ever becomes real, you will hear about it — once.
        </p>
      ) : (
        <form className={styles.form} onSubmit={submit} aria-describedby="kit-notice">
          <div className={styles.field}>
            <label className={styles.label} htmlFor="kit-email">
              Email address
            </label>
            <input
              className={styles.input}
              id="kit-email"
              type="email"
              name="email"
              required
              autoComplete="email"
              placeholder="you@example.com"
            />
          </div>

          <input
            className={styles.trap}
            type="text"
            name="_gotcha"
            tabIndex={-1}
            autoComplete="off"
            aria-hidden="true"
          />

          <button
            className="btn btn-primary"
            type="submit"
            disabled={!hydrated || status === 'sending'}
          >
            {status === 'sending' ? 'Sending…' : 'Keep me posted'}
          </button>

          {status === 'failed' && (
            <p className={styles.failed} role="alert">
              That did not go through. Please try again in a moment.
            </p>
          )}
        </form>
      )}

      <p className={styles.notice} id="kit-notice">
        <strong>There is no kit yet, and this is not a pre-order.</strong> No price has been set and
        nothing is for sale. Based on people interested we will try to get your hands on one.
        One message, only if it happens, and your address is used for nothing else.
      </p>
    </section>
  )
}
