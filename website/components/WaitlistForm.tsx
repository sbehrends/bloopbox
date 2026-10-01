import { waitlist } from '@/lib/site'

import styles from './WaitlistForm.module.css'

/** Plain HTML form: the site is a static export and this works without JavaScript. Copy must never imply the device is buyable (see `website/README.md`). */
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
