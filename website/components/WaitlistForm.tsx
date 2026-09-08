import { waitlist } from '@/lib/site'

import styles from './WaitlistForm.module.css'

/**
 * "I would rather not build it myself."
 *
 * A plain HTML form, posting to a third-party endpoint. The site is a static export, so there is
 * no Route Handler to post to and no server action to call — and a form built out of `fetch`
 * would be a form that fails silently for anyone whose JavaScript has not arrived yet.
 *
 * **The copy is load-bearing.** `website/README.md` holds the line that nothing on this site may
 * imply the device is buyable or shipping, because it is not: no kit exists, no price exists, and
 * nobody has taken an order. So this collects interest and says exactly that, twice — once in the
 * body and once in the note under the button. Do not let it drift into sounding like a pre-order.
 */
export function WaitlistForm() {
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

      <form
        className={styles.form}
        action={waitlist.endpoint}
        method="POST"
        aria-describedby="kit-notice"
      >
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

        {/* Honeypot. A person never sees this; a bot fills it and the endpoint drops the row. */}
        <input
          className={styles.trap}
          type="text"
          name="_gotcha"
          tabIndex={-1}
          autoComplete="off"
          aria-hidden="true"
        />

        <button className="btn btn-primary" type="submit">
          Keep me posted
        </button>
      </form>

      <p className={styles.notice} id="kit-notice">
        <strong>There is no kit yet, and this is not a pre-order.</strong> No price has been set and
        nothing is for sale. Based on people interested we will try to get your hands on one.
        One message, only if it happens, and your address is used for nothing else.
      </p>
    </section>
  )
}
