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

/** The three reasons a box beats a phone, each with the picture that carries it. All three are
 *  finished art in the house style `website/components/Figure.tsx` defines, cropped to 16:10 by
 *  `.mediaCardImage` — the source frames are 16:9, so the crop takes 5% off each side. */
const REASONS = [
  {
    title: 'Theirs, not yours',
    src: '/why-1-girl.jpeg',
    alt: 'A small child holding a bloopbox in both hands, grinning, in her own room.',
    body: 'No handing over a phone. No apps, no feed, no camera, no notifications from anywhere else. The box does one thing, so there is nothing to get lost in and nothing to close.',
  },
  {
    title: 'Colour is the address',
    src: '/why-2-box.jpeg',
    alt: 'A child’s finger pressing the lit coral button on a bloopbox, the faces under each cap in view.',
    body: 'They can’t read a name, but they know yellow is Mum. Three colours and three lamps is the whole interface, and it fits in a two-year-old’s head on the first day.',
  },
  {
    title: 'Ordinary WhatsApp at the far end',
    src: '/why-3-voice.jpeg',
    alt: 'A grandmother in her living room, delighted, playing a voice note on her ordinary phone.',
    body: 'The box is a linked device on an account you already have. Notes arrive in Grandma’s normal chat, on her normal phone. She installs nothing and learns nothing.',
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
        {/* Full-bleed: the photograph is the background, and the copy sits on a veil of the page
            colour so navy ink reads on cream by day and cream ink on navy after dark, with one
            unchanging photograph underneath. */}
        <section className={styles.hero}>
          <div className={styles.heroMedia}>
            <img
              src="/bloopbox-hero.jpeg"
              alt="A bloopbox on a child’s table beside wooden toys and picture books, its yellow button lit."
              fetchPriority="high"
              decoding="async"
            />
          </div>

          <div className={`wrap ${styles.heroInner}`}>
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
          </div>
        </section>

        {/* ---- why ---- */}
        <section className={`wrap ${styles.section}`}>
          <p className="eyebrow rise">Why a box</p>
          <div className={`${styles.split} rise`}>
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

          <div className={`${styles.cards} rise-group`}>
            {REASONS.map((reason) => (
              <article className={`card ${styles.mediaCard}`} key={reason.title}>
                <img
                  className={styles.mediaCardImage}
                  src={reason.src}
                  alt={reason.alt}
                  loading="lazy"
                  decoding="async"
                />
                <div className={styles.mediaCardBody}>
                  <h3>{reason.title}</h3>
                  <p>{reason.body}</p>
                </div>
              </article>
            ))}
          </div>
        </section>

        {/* ---- one person per button: the page's one dark band ---- */}
        
        <section id="people" className={styles.night}>
          <div className="wrap">
            <p className={`eyebrow ${styles.nightEyebrow} rise`}>One button, one person</p>
            <div className={`${styles.split} rise`}>
              <h2>Every button is somebody.</h2>
              <p className="lede">
                You decide who lives behind each colour: Mum on the yellow one, Dad on the red
                one, Grandma on the blue. The child never picks from a list or says a name to a
                machine — they press the person they want. And when that person answers, their
                colour is the thing that lights up across the room.
              </p>
            </div>

            {/* Each lamp plays the unread-message blink from `docs/PRODUCT.md` §6 — 0.8 s on, 0.8 s
                off, three times — then rests for the remaining twelve seconds of a 16 s cycle. The
                three are staggered so only one is ever lit: the box answers one person at a time,
                which is what the paragraph above claims. */}
            <div className={`${styles.cards} rise-group`}>
              {WHO.map((entry) => (
                <article
                  className={`card ${styles.whoCard}`}
                  key={entry.title}
                  style={
                    {
                      '--cap': `var(--ch-${entry.channel})`,
                      '--cap-off': `var(--ch-${entry.channel}-off)`,
                    } as React.CSSProperties
                  }
                >
                  <span className={styles.swatch} aria-hidden="true" />
                  <h3>{entry.title}</h3>
                  <p>{entry.body}</p>
                </article>
              ))}
            </div>
          </div>
        </section>

        {/* ---- how ---- */}
        <section id="how" className={`wrap ${styles.section}`}>
          <p className="eyebrow rise">How it works</p>
          <h2 className={`${styles.sectionTitle} rise`}>Two gestures, in this order.</h2>

          {/* Numbered because it genuinely is a sequence: press, release, reply. */}
          <ol className={`${styles.steps} rise-group`}>
            <li className={styles.step}>
              <span className={styles.stepNumber}>01</span>
              <h3>Hold, and talk</h3>
              <p>
                The lamp goes solid the instant they press, so the box is listening.
              </p>
            </li>
            <li className={styles.step}>
              <span className={styles.stepNumber}>02</span>
              <h3>Let go</h3>
              <p>
                A whoosh, three quick flashes, and it is sent, a voice note ont it's way.
              </p>
            </li>
            <li className={styles.step}>
              <span className={styles.stepNumber}>03</span>
              <h3>Tap what’s blinking</h3>
              <p>
                A reply lights that person’s button. One tap plays everything they sent.
              </p>
            </li>
          </ol>
        </section>

        {/* ---- for parents ---- */}
        <section id="parents" className={`wrap ${styles.section}`}>
          <p className="eyebrow rise">For the adult who sets it up</p>
          <h2 className={`${styles.sectionTitle} rise`}>Built for a child’s room.</h2>

          <div className={`${styles.cards} rise-group`}>
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
                Recordings live in memory, never on the card. Security first. No recordings are permanently stored.
              </p>
            </article>
            <article className="card">
              <h3>It goes quiet at night</h3>
              <p>
                Switch on quiet hours and have the messages waiting for the morning. No sleep is interrupted.
              </p>
            </article>
          </div>
        </section>

        {/* ---- closing ---- */}
        <section className={`wrap ${styles.closing}`}>
          <img src="/bloopbox-logo-light.svg" alt="" className={styles.mark} />
          <h2 className={styles.closingTitle}>Three buttons. Three people who love them.</h2>
          <p className={styles.closingLede}>
            Everything that makes this work, hardware to software, is open source. Take it and
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
