import { DeviceDemo } from '@/components/DeviceDemo'
import { SiteFooter } from '@/components/SiteFooter'
import { SiteHeader } from '@/components/SiteHeader'
import { channels, links } from '@/lib/site'

import styles from './page.module.css'

/** Who a button can be. The order is the order of the caps on the enclosure and of the rings in
 *  the mark: yellow, coral, teal — so the swatch on each card means "which button", which is the
 *  only thing a channel colour is ever allowed to mean. */
const WHO = [
  {
    channel: 1,
    title: 'A person',
    body: 'A phone number, and that is the whole setup. Anyone with WhatsApp, anywhere in the world. Nothing for them to install, nothing to sign up for, nothing to remember.',
  },
  {
    channel: 2,
    title: 'Or a whole family',
    body: 'Point a button at a group chat and everyone in it can send, and everyone hears what the child sends back. That is how “the cousins” fit behind one button.',
  },
  {
    channel: 3,
    title: 'And nobody else',
    body: 'Only the three you assign can reach the box. Unknown numbers, groups nobody chose, broadcasts — dropped before a single second of audio is downloaded.',
  },
] as const

/** The header's own links. Anchors into this page; `SiteHeader` appends the manual. */
const NAV = [
  { href: '#people', label: 'Three people' },
  { href: '#how', label: 'How it works' },
  { href: '#parents', label: 'For parents' },
] as const

export default function Home() {
  return (
    <>
      <a className="skip" href="#main">
        Skip to content
      </a>

      <SiteHeader nav={NAV} />

      <main id="main">
        {/* ---- hero ---- */}
        <section className={`wrap ${styles.hero}`}>
          <div className={styles.heroCopy}>
            <p className={styles.kicker}>
              <span className={styles.kickerDots} aria-hidden="true">
                {channels.map((channel) => (
                  <span key={channel.n} style={{ background: `var(--${channel.token})` }} />
                ))}
              </span>
              A WhatsApp voice messenger for the little ones
            </p>

            <h1>Screenless connection for little humans.</h1>

            <p className={`lede ${styles.heroLede}`}>
              Three illuminated buttons, and one loved one behind each. Hold a button to send
              a voice note; tap it when it lights up to hear what came back. No screen, no menus, no
              reading — this is a thing a two-year-old can use on their own.
            </p>

            <div className={styles.ctas}>
              <a className="btn btn-primary" href={links.build}>
                Build one yourself
              </a>
              <a className="btn btn-secondary" href={links.releases}>
                Download the software
              </a>
            </div>

            <p className={styles.fineprint}>
              Open source, and free. Off-the-shelf parts and a Raspberry Pi.
            </p>
          </div>

          <div className={styles.heroDevice}>
            <DeviceDemo />
            <p className={styles.tryIt}>
              Go on — hold a button for a moment, then let go. This is the real timing.
            </p>
          </div>
        </section>

        {/* ---- why ---- */}
        <section className={`wrap ${styles.section}`}>
          <p className="eyebrow">Why a box</p>
          <div className={styles.split}>
            <h2>
              A two-year-old can’t work a phone.
              <br />
              They can work a button.
            </h2>
            <p className="lede">
              A video call needs an adult to place it, a screen to hold, and a small person willing
              to stay in front of it. A voice note needs none of that. It can be sent the moment a
              two-year-old thinks of something, and heard the moment a light comes on — no calendars,
              no time zones, and nobody standing in the middle of it.
            </p>
          </div>

          <div className={styles.cards}>
            <article className="card">
              <h3>Theirs, not yours</h3>
              <p>
                No handing over a phone. No apps, no feed, no camera, no notifications from anywhere
                else. The box does one thing, so there is nothing to get lost in and nothing to
                close.
              </p>
            </article>
            <article className="card">
              <h3>Colour is the address</h3>
              <p>
                They can’t read a name, but they know yellow is Mum. Three colours and three lamps
                is the whole interface, and it fits in a two-year-old’s head on the first day.
              </p>
            </article>
            <article className="card">
              <h3>Ordinary WhatsApp at the far end</h3>
              <p>
                The box is a linked device on an account you already have. Notes arrive in Grandma’s
                normal chat, on her normal phone. She installs nothing and learns nothing.
              </p>
            </article>
          </div>
        </section>

        {/* ---- one person per button: the page's one dark band ---- */}
        <section id="people" className={styles.night}>
          <div className="wrap">
            <p className={`eyebrow ${styles.nightEyebrow}`}>One button, one person</p>
            <div className={styles.split}>
              <h2>Every button is somebody.</h2>
              <p className="lede">
                You decide who lives behind each colour: Mum on the yellow one, Dad on the coral
                one, Grandma on the blue. The child never picks from a list or says a name to a
                machine — they press the person they want. And when that person answers, their
                colour is the thing that lights up across the room.
              </p>
            </div>

            <div className={styles.cards}>
              {WHO.map((entry) => (
                <article className={`card ${styles.whoCard}`} key={entry.title}>
                  <span
                    className={styles.swatch}
                    style={{ '--cap': `var(--ch-${entry.channel})` } as React.CSSProperties}
                    aria-hidden="true"
                  />
                  <h3>{entry.title}</h3>
                  <p>{entry.body}</p>
                </article>
              ))}
            </div>
          </div>
        </section>

        {/* ---- how ---- */}
        <section id="how" className={`wrap ${styles.section}`}>
          <p className="eyebrow">How it works</p>
          <h2 className={styles.sectionTitle}>Two gestures, in this order.</h2>

          {/* Numbered because it genuinely is a sequence: press, release, reply. */}
          <ol className={styles.steps}>
            <li className={styles.step}>
              <span className={styles.stepNumber}>01</span>
              <h3>Hold, and talk</h3>
              <p>
                The lamp goes solid the instant they press, so the box has answered before they have
                finished pressing. A grip that slips costs nothing: press again within a moment and
                the same message carries on.
              </p>
            </li>
            <li className={styles.step}>
              <span className={styles.stepNumber}>02</span>
              <h3>Let go</h3>
              <p>
                A whoosh, three quick flashes, and it is gone — a voice note in the chat, capped at
                thirty seconds. A brush past the box, under a sixth of a second, is ignored
                entirely.
              </p>
            </li>
            <li className={styles.step}>
              <span className={styles.stepNumber}>03</span>
              <h3>Tap what’s blinking</h3>
              <p>
                A reply lights that person’s button. One tap plays everything they sent, oldest
                first, and the lamp goes dark when the last one finishes.
              </p>
            </li>
          </ol>
        </section>

        {/* ---- for parents ---- */}
        <section id="parents" className={`wrap ${styles.section}`}>
          <p className="eyebrow">For the adult who sets it up</p>
          <h2 className={styles.sectionTitle}>Built for a child’s room.</h2>

          <div className={styles.cards}>
            <article className="card">
              <h3>No screen, ever</h3>
              <p>
                Nothing to swipe, nothing to watch, no camera and no way out of it. The single thing
                this object can do is talk to three people you chose.
              </p>
            </article>
            <article className="card">
              <h3>Nothing is kept</h3>
              <p>
                Recordings live in memory, never on the card. A played note is deleted the moment it
                finishes; one nobody plays expires after 48 hours.
              </p>
            </article>
            <article className="card">
              <h3>It goes quiet at night</h3>
              <p>
                Switch on quiet hours, pick your timezone, and 20:00–07:00 is there to change.
                Holding the outer two buttons for three seconds silences the cues on the spot.
                Playback still works — a child who taps a light expects to hear something.
              </p>
            </article>
          </div>
        </section>

        {/* ---- closing ---- */}
        <section className={`wrap ${styles.closing}`}>
          <img src="/bloopbox-logo-light.svg" alt="" className={styles.mark} />
          <h2 className={styles.closingTitle}>Three buttons. Three people who love them.</h2>
          <p className={styles.closingLede}>
            Everything that makes this work — hardware to software — is open source. Take it and
            build one.
          </p>
          <div className={styles.ctas}>
            <a className="btn btn-primary" href={links.build}>
              Build one yourself
            </a>
            <a className="btn btn-secondary" href={links.releases}>
              Download the software
            </a>
          </div>
        </section>
      </main>

      <SiteFooter />
    </>
  )
}
