import type { Metadata } from 'next'

import { Figure } from '@/components/Figure'
import { GpioDiagram } from '@/components/GpioDiagram'
import { LightSignature } from '@/components/LightSignature'
import { SiteFooter } from '@/components/SiteFooter'
import { SiteHeader } from '@/components/SiteHeader'
import { WaitlistForm } from '@/components/WaitlistForm'
import { download, links, parts, site } from '@/lib/site'

import styles from './page.module.css'

export const metadata: Metadata = {
  title: `Build your first ${site.name}`,
  description:
    'A step-by-step build manual for bloopbox: the parts to buy, how to flash the card, how the buttons wire to the Raspberry Pi, and how to set up Wi-Fi, WhatsApp and the three buttons. Written for parents. No electronics knowledge needed.',
  openGraph: {
    type: 'article',
    title: `Build your first ${site.name}`,
    description:
      'The parts, the wiring and the setup',
  },
}

const NAV = [
  { href: '#parts', label: 'Parts' },
  { href: '#card', label: 'The card' },
  { href: '#hardware', label: 'The hardware' },
  { href: '#setup', label: 'Setup' },
] as const

/** The three parts of the build, as the reader meets them. */
function Step({
  n,
  title,
  children,
}: {
  readonly n: number
  readonly title: string
  readonly children: React.ReactNode
}) {
  return (
    <section className={`${styles.step} rise`} id={`step-${n}`}>
      <div className={styles.stepHead}>
        <span className={styles.stepNumber} aria-hidden="true">
          {String(n).padStart(2, '0')}
        </span>
        <h3 className={styles.stepTitle}>
          <span className={styles.srOnly}>Step {n}: </span>
          {title}
        </h3>
      </div>
      <div className={styles.stepBody}>{children}</div>
    </section>
  )
}

/** A thing worth stopping for. Amber, because coral and the danger red both mean something
 *  else on this device — `docs/BRAND.md`. */
/* Children are rendered as-is rather than wrapped in a `<p>`: one note needs several
   paragraphs, and a `<ul>` or a second `<p>` inside one is invalid HTML. Every caller wraps
   its own prose, and `.note p` styles it either way. */
function Note({ title, children }: { readonly title: string; readonly children: React.ReactNode }) {
  return (
    <aside className={styles.note}>
      <p className={styles.noteTitle}>{title}</p>
      {children}
    </aside>
  )
}

export default function Manual() {
  return (
    <>
      <a className="skip" href="#main">
        Skip to content
      </a>

      <SiteHeader nav={NAV} current="manual" />

      <main id="main">
        {/* ---- intro ---- */}
        <section className={`wrap ${styles.hero}`}>
          <div className={styles.heroCopy}>
            <p className="eyebrow">The build manual</p>
            <h1>Build your first bloopbox.</h1>
            <p className={`lede ${styles.heroLede}`}>
              Out of the shelf parts, an afternoon and a computer. Nothing you need to understand about electronics.
            </p>

            <dl className={styles.facts}>
              <div>
                <dt>Time</dt>
                <dd>2–3 hours setup time</dd>
              </div>
              <div>
                <dt>Hardest part</dt>
                <dd>Counting to pin 11</dd>
              </div>
            </dl>
          </div>

          <Figure
            src="/manual-hero.jpeg"
            alt="Three bloopboxes side by side in different cases — a smooth red plastic one, a wooden box, and a cardboard box — each with three coloured buttons, photo windows and a speaker grille."
            caption="What you are building. The printable case in the repository is the recommended one — but a wooden box or a cardboard one works just as well."
            ratio="1195 / 896"
          />
        </section>

        {/* ---- what you're getting into ---- */}
        <section className={`wrap ${styles.section}`}>
          <p className="eyebrow rise">Before you start</p>
          <div className={`${styles.split} rise`}>
            <h2>Software first, then hardware, then a phone.</h2>
            <p className="lede">
              The order matters more than it looks. You write the software to the memory card
              before anything is screwed together, because a card is much easier to reach when it
              is not inside a box. Then the parts go together. Then you finish the setup from your
              phone, with the box already sitting where it is going to live.
            </p>
          </div>

          <ol className={`${styles.phases} rise-group`}>
            <li>
              <span className={styles.phaseTag}>Steps 1–3</span>
              <h3>The memory card</h3>
              <p>
                Download the software, write it to the card, put the card in the Pi. Twenty minutes,
                and most of that is a progress bar.
              </p>
            </li>
            <li>
              <span className={styles.phaseTag}>Steps 4–7</span>
              <h3>The hardware</h3>
              <p>
                Sound card on, speakers in, buttons wired, everything into the case. This is the
                part with a screwdriver in it.
              </p>
            </li>
            <li>
              <span className={styles.phaseTag}>Steps 8–11</span>
              <h3>Wi-Fi, WhatsApp, people</h3>
              <p>
                Power it up and finish from your phone: join your network, link WhatsApp, and decide
                who lives behind each colour.
              </p>
            </li>
          </ol>
        </section>

        {/* ---- the kit alternative ---- */}
        <section className={`wrap ${styles.kit} rise`}>
          <WaitlistForm />
        </section>

        {/* ---- bill of materials ---- */}
        <section id="parts" className={`wrap ${styles.section}`}>
          <p className="eyebrow rise">What to buy</p>
          <h2 className={`${styles.sectionTitle} rise`}>The bill of materials.</h2>
          <p className={`lede ${styles.sectionLede} rise`}>
            Everything here is an ordinary, stocked part — nothing custom, nothing hard to find.
            Expect somewhere around €70–110 all in, depending on what you already have in a drawer.
          </p>

          <Figure
            src="/parts-flatlay.jpg"
            alt="The parts laid out: three arcade buttons in yellow, coral and teal, a Raspberry Pi 3B+, a WM8960 audio HAT, and a pair of small speakers."
            caption="The four parts that matter. The rest — card, power supply, wires — you may already own."
            ratio="1195 / 896"
          />

          <div className={`${styles.tableScroll} rise`}>
            <table className={styles.parts}>
              <caption className={styles.srOnly}>
                Parts needed to build one bloopbox, with quantities and notes
              </caption>
              <thead>
                <tr>
                  <th scope="col">Part</th>
                  <th scope="col">Qty</th>
                  <th scope="col">What it is for</th>
                </tr>
              </thead>
              <tbody>
                {parts.map((part) => (
                  <tr key={part.name}>
                    <th scope="row">
                      {part.href === null ? (
                        part.name
                      ) : (
                        <a href={part.href} rel="noreferrer">
                          {part.name}
                        </a>
                      )}
                    </th>
                    <td className={styles.qty}>{part.qty}</td>
                    <td>{part.note}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className={`${styles.noteRow} rise-group`}>
            <Note title="Which Raspberry Pi?">
              <p>
                The whole build was tested on a <strong>Raspberry Pi 3B+</strong>, so that is the one
                this manual describes and the only one anyone has actually proved works end to end. A{' '}
                <strong>Pi 4</strong>, <strong>Pi 5</strong> or <strong>Pi Zero 2 W</strong> should all
                work too — they share the same 40-pin header and the same pin numbering, which is
                everything this build depends on. The differences are practical rather than
                electrical: the 4 and 5 want USB-C power instead of micro-USB, and the Zero 2 W needs
                its header soldered on unless you buy the version that comes with one. If you are
                buying a board specifically for this, the Zero 2 W is the smallest and the 3B+ is the
                one we can promise.
              </p>
            </Note>

            <Note title="* About those button wires">
              <p>
                An arcade button’s terminals are <strong>2.8 mm flat tabs</strong>. A Pi pin wants a
                female <strong>Dupont</strong> socket. A lead with one of each on it does exist, but
                it is not a thing most shops stock, and hunting for one is the only part of this
                build likely to make you close a browser tab in disgust. Three ways round it, in the
                order we would try them:
              </p>
              <ul className={styles.list}>
                <li>
                  <strong>Crimp your own.</strong> A bag of fifty 2.8 mm crimp terminals costs about
                  a euro. Cut one end off a female-to-female Dupont lead, crimp the tab on, done —
                  no soldering, and it is the same joint the ready-made lead would have had.
                </li>
                <li>
                  <strong>Solder to the tab.</strong> If you own an iron, this is the strongest of
                  the three and takes about a minute a wire.
                </li>
                <li>
                  <strong>Twist and insulate.</strong> Strip a Dupont lead, hook the bare wire
                  through the hole in the tab, twist it tight, cover it with heat-shrink or tape. It
                  works — but it is also the one that will eventually shake loose inside a box that
                  gets picked up and dropped, so treat it as the way to find out whether the box is
                  fun before you commit to it.
                </li>
              </ul>
            </Note>

            <Note title="Which case?">
              <p>
                There is a <strong>3D-printable case</strong> in the repository, sized for these exact
                parts, and printing it is the shortest route to something that looks finished. It is
                not the interesting route. This is a box that will sit in a child’s room for years,
                and the best ones we have seen are a wooden cigar box, a biscuit tin and a hollowed-out
                picture book. Anything with a lid, room for a fist-sized board and somewhere to drill
                three 30 mm holes will do it. Please build a strange one.
              </p>
            </Note>
          </div>
        </section>

        {/* ================= PART ONE ================= */}
        <section id="card" className={`wrap ${styles.section}`}>
          <p className="eyebrow rise">Part one — the memory card</p>
          <h2 className={`${styles.sectionTitle} rise`}>Put the software on first.</h2>
          <p className={`lede ${styles.sectionLede} rise`}>
            Nothing is assembled yet. This is all done on your computer, with the card in a slot or
            a USB adapter.
          </p>

          <div className={styles.steps}>
            <Step n={1} title="Download the card image">
              <p>
                One file, about a gigabyte. It contains the operating system and the bloopbox
                software together, already configured — there is nothing to install afterwards and
                no command line anywhere in this manual.
              </p>
              <p>
                Grab the file whose name contains <code>wm8960</code>. That is the build that knows
                about the audio HAT you are about to plug in; the plain one does not turn the sound
                card on and you will get a box that lights up and stays silent.
              </p>
              <p>
                <a className="btn btn-primary" href={download.image}>
                  Download the card image
                </a>
              </p>
              <Note title="Not published yet">
                <p>
                  There is no released image to download at the moment — that button points at the
                  releases page, which is currently empty. Until one is published you can build the
                  card yourself from the source, which is written up in the repository’s{' '}
                  <a href={links.deployment} rel="noreferrer">
                    deployment notes
                  </a>
                  .
                </p>
              </Note>
            </Step>

            <Step n={2} title="Write it to the card with Balena Etcher">
              <p>
                <a href={download.etcher} rel="noreferrer">
                  Balena Etcher
                </a>{' '}
                is free, runs on Mac, Windows and Linux, and does exactly one thing. Install it, open
                it, and it will ask you for three things in order:{' '}
                <strong>the file you just downloaded</strong>, <strong>the memory card</strong>, and{' '}
                <strong>permission to go ahead</strong>. Then it writes, verifies, and tells you it
                is finished.
              </p>
              <p>
                Do not unzip the download first — Etcher reads the compressed file directly. Writing
                and verifying takes five to fifteen minutes depending on the card.
              </p>
              <Figure
                src="/manual-flash.jpeg"
                alt="A laptop on a desk showing three icons in a row — a file, a memory card, a large round button — with a progress bar beneath them. A microSD card lies beside the laptop."
                caption="Etcher’s whole interface is these three steps, left to right."
                ratio="1376 / 768"
              />
              <Note title="It will warn you, and that is fine">
                <p>
                  Your computer may announce that the card is unreadable and offer to format it, both
                  before and after writing. Say no every time. The card holds a Linux filesystem that
                  Windows and macOS genuinely cannot read; letting either of them &ldquo;fix&rdquo; it
                  erases the work.
                </p>
              </Note>
            </Step>

            <Step n={3} title="Put the card in the Pi">
              <p>
                The slot is on the underside of the board, at the edge opposite the USB ports. The
                card only goes in one way round — contacts facing the board — and it pushes in until
                it stops. On a 3B+ it does not click and it does not sit flush; a couple of
                millimetres proud is correct.
              </p>
              <p>Leave the power off. The next four steps are all hardware.</p>
              <Figure
                src="/manual-card.jpeg"
                alt="Two hands holding a Raspberry Pi board tilted to show its underside, sliding a microSD card into the slot at the board’s edge."
                caption="Underside, far edge from the USB ports."
                ratio="1376 / 768"
              />
            </Step>
          </div>
        </section>

        {/* ================= PART TWO ================= */}
        <section id="hardware" className={`wrap ${styles.section}`}>
          <p className="eyebrow rise">Part two — the hardware</p>
          <h2 className={`${styles.sectionTitle} rise`}>Now put it together.</h2>
          <p className={`lede ${styles.sectionLede} rise`}>
            Four steps with the power unplugged the whole way through. Nothing here can be wired
            backwards in a way that breaks anything — the worst case is a button that does nothing
            until you move one wire.
          </p>

          <div className={styles.steps}>
            <Step n={4} title="Push the audio HAT onto the Pi">
              <p>
                The HAT is the small blue board. It has a two-row socket underneath that matches the
                two-row block of forty pins on the Pi, and it only fits one way: the HAT sits over
                the board, not hanging off the end. Line up the socket with the pins and press
                straight down until it stops. It takes more force than you expect.
              </p>
              <p>
                <strong>The pins you need are still there afterwards.</strong> The HAT passes the
                header straight through to a matching row of pins on its own top side, so all forty
                are as reachable with it seated as they were before. Nothing else goes between the
                two boards, and step 6 wires onto that top row.
              </p>
              <Figure
                src="/manual-hat.jpeg"
                alt="Two circuit boards drawn one above the other: a green Raspberry Pi below, a small blue audio HAT above it, with dotted lines showing the two rows of pins lining up, and a matching row of pins along the top of the blue board."
                caption="Straight onto the Pi. The top row of pins is where the buttons go."
                ratio="1375 / 768"
              />
            </Step>

            <Step n={5} title="Screw the speakers into the HAT">
              <p>
                The HAT has two pairs of screw terminals along one edge, marked left and right. Each
                speaker has two wires. Loosen a screw with a small flat screwdriver, push the bare
                end of the wire into the hole, tighten the screw, tug gently to check it holds. Then
                do the same for every wire you have.
              </p>
              <p>
                <strong>You may already have these.</strong> A lot of WM8960 HATs come with a small
                speaker in the box. One is enough — the box records and plays in mono — so if yours
                arrived with a single speaker, wire it into either pair of terminals and leave the
                other pair empty.
              </p>
              <p>
                Speakers have no polarity worth worrying about here. If you swap the two wires on one
                speaker nothing breaks — at worst a stereo recording sounds slightly odd, and this
                box records in mono anyway.
              </p>
              <Note title="The HAT is the microphone too">
                <p>
                  There are two tiny microphones on the HAT itself, so nothing else needs plugging in
                  for the child to be heard. Keep those two little holes clear of the case wall when
                  you get to step 7 — a microphone pressed against plastic records plastic.
                </p>
              </Note>
            </Step>

            <Step n={6} title="Wire the three buttons">
              <p>
                This is the only step where it matters which hole a wire goes into, so it has a
                diagram. Take it slowly and it is fifteen minutes.
              </p>

              <h4 className={styles.subhead}>What is on the back of a button</h4>
              <p>
                An illuminated arcade button has <strong>four spade terminals</strong> on the back,
                in two pairs, and the two pairs do different jobs:
              </p>
              <ul className={styles.list}>
                <li>
                  <strong>The switch pair</strong> is on the microswitch — the small boxy part that
                  clicks. These two tell the Pi the button was pressed. Either way round.
                </li>
                <li>
                  <strong>The lamp pair</strong> is on the bulb holder, usually a separate little
                  cylinder that twists out. These two light the button up. An LED lamp may care which
                  way round it goes — if one button never lights, swap its two lamp wires before
                  suspecting anything else.
                </li>
              </ul>
              <p>
                Push-on flat connectors slide onto these — 2.8 mm is the size. On the Pi end, the
                wire has to finish in a female Dupont socket. If your leads did not come with one of
                each, the note under the parts table has the three ways of getting there.
              </p>

              <h4 className={styles.subhead}>Where each wire goes</h4>
              <p>
                Twelve wires, and every one of them goes to the Pi’s own header: six for the
                switches — one per button to a numbered pin, one per button to a ground pin — and six
                for the lamps, exactly the same way. Count pins carefully: <strong>pin 1 is the
                corner nearest the microSD card</strong>, odd numbers run down one side and even
                down the other.
              </p>

              <GpioDiagram />

              <div className={styles.legend}>
                <span>
                  <span className={styles.key} style={{ background: 'var(--ch-1)' }} /> Button 1 —
                  left, yellow
                </span>
                <span>
                  <span className={styles.key} style={{ background: 'var(--ch-2)' }} /> Button 2 —
                  centre, coral
                </span>
                <span>
                  <span className={styles.key} style={{ background: 'var(--ch-3)' }} /> Button 3 —
                  right, teal
                </span>
              </div>

              <p>
                The <strong>lamps go straight onto the header too</strong> — one leg on the numbered
                pin, the other on a ground pin. That works because the lamps in these buttons are
                3 V ones, which is what the Pi’s pins put out: no driver board, no separate power,
                nothing between the pin and the bulb. If you have 5 V or 12 V arcade buttons in a
                drawer, they will look identical and stay dark — check the lamp before you wire
                anything.
              </p>

              <Figure
                src="/manual-wiring.jpeg"
                alt="A wiring diagram: three arcade buttons in yellow, coral and teal down the left, each with two terminals, and colour-matched wires running right to a two-column pin header."
                caption="The same information as the pin map, drawn as wires. Colours match the caps."
                ratio="1408 / 768"
              />

              <Note title="If a button does nothing later">
                <p>
                  Nine times out of ten it is one wire on the neighbouring pin. The pins are 2.5 mm
                  apart and it is genuinely easy to be one row out — count again from pin 1 rather than
                  assuming a part is faulty.
                </p>
              </Note>
            </Step>

            <Step n={7} title="Fit it all into the case">
              <p>
                Buttons first: each one drops through its 30 mm hole from the front and is held by a
                ring nut that screws on from behind, finger-tight and then a nudge. Do the wiring
                before the lid goes on — reaching inside a closed box to find a spade terminal is
                nobody’s afternoon.
              </p>
              <p>Then the board, and three things worth getting right:</p>
              <ul className={styles.list}>
                <li>
                  <strong>The speakers face outward</strong>, behind whatever grille or drilled holes
                  you have. A speaker firing into a sealed cavity sounds like a phone in a pocket.
                </li>
                <li>
                  <strong>The HAT’s microphones stay clear of the walls.</strong> A few millimetres of
                  air is enough.
                </li>
                <li>
                  <strong>The power cable gets strain relief.</strong> A knot on the inside of the
                  case, or a cable tie anchored to something, so that a toddler pulling the cable
                  moves the box rather than the socket on the board.
                </li>
              </ul>
              <p>
                Leave the lid off for now. You are about to find out whether it all works, and the
                first boot is much more pleasant when you can still reach things.
              </p>
            </Step>
          </div>
        </section>

        {/* ================= PART THREE ================= */}
        <section id="setup" className={`wrap ${styles.section}`}>
          <p className="eyebrow rise">Part three — Wi-Fi, WhatsApp, people</p>
          <h2 className={`${styles.sectionTitle} rise`}>Finish it from your phone.</h2>
          <p className={`lede ${styles.sectionLede} rise`}>
            No screen, no keyboard, nothing to plug into a monitor. The box raises its own Wi-Fi
            network for exactly this, and you do the rest in a browser.
          </p>

          <div className={styles.steps}>
            <Step n={8} title="Plug it in and wait">
              <p>
                Connect the power supply. There is no on switch — the box is on whenever it has
                power, which is the point of a device a two-year-old operates.
              </p>
              <p>
                <strong>The first boot takes up to a minute</strong>, and it is longer than every
                boot after it. You will see the three lights chase left to right while it starts,
                then blink together while it looks for a network it does not have yet. That second
                pattern is your cue that it is ready for the next step.
              </p>
              <p>
                If the lights never come on at all, the card is not seated or the power supply is
                too small. If they come on and stay solid, that is the box telling you it has no
                network and no way to offer you one — give it another thirty seconds before worrying.
              </p>
            </Step>

            <Step n={9} title="Join its Wi-Fi and tell it about yours">
              <p>
                About twenty seconds after failing to find a network, the box gives up and makes its
                own. On your phone, open Wi-Fi settings and look for a network called{' '}
                <code>bloopbox-</code> followed by four characters. It is open — there is no password
                — and the three lights double-pulse together the whole time it is up.
              </p>
              <p>
                Join it. A setup page should open by itself, the way a hotel Wi-Fi page does. If it
                does not, open a browser and go to <code>http://10.42.0.1</code>.
              </p>
              <p>It asks for two things:</p>
              <ol className={styles.list}>
                <li>
                  <strong>Your home Wi-Fi</strong>, picked from a list, and its password. The box
                  needs 2.4 GHz — most home routers broadcast both bands under one name and it will
                  find the right one on its own.
                </li>
                <li>
                  <strong>A settings password</strong>, at least six characters. This protects the
                  settings page from here on. Your child never needs it and never sees it; you will
                  need it in about four minutes.
                </li>
              </ol>
              <p>
                When you save, the box shuts down its own network and joins yours — so the page you
                are looking at will die mid-sentence. That is supposed to happen. Watch the lights
                instead: double-pulsing, then blinking together, then dark. Dark means done.
              </p>
              <Figure
                src="/manual-09.jpeg"
                alt="A hand holding a phone that shows a Wi-Fi setup form — a network field, a password field and a save button under a Wi-Fi symbol — with a bloopbox beside it, one button glowing."
                caption="The setup page, on the box’s own network. It closes itself when it succeeds."
                ratio="1376 / 768"
              />
              <Note title="If the page never appears">
                <p>
                  Some phones quietly drop a Wi-Fi network that has no internet behind it. If yours
                  keeps hopping back to mobile data, turn mobile data off for a minute, rejoin, and go
                  to <code>http://10.42.0.1</code> by hand.
                </p>
              </Note>
            </Step>

            <Step n={10} title="Link WhatsApp">
              <p>
                Back on your normal Wi-Fi, on a phone or a laptop, open{' '}
                <code>http://bloopbox.local:3000/admin/</code>. Sign in with the settings password
                you just chose — any username works, only the password is checked.
              </p>
              <p>
                Open the <strong>WhatsApp</strong> section. The box needs to be linked to a WhatsApp
                account the same way WhatsApp Web is, and there are two ways to do it:
              </p>
              <ul className={styles.list}>
                <li>
                  <strong>Scan the QR code.</strong> On your phone: WhatsApp → Settings → Linked
                  devices → Link a device. Point it at the screen.
                </li>
                <li>
                  <strong>Use a pairing code.</strong> Type your number, press{' '}
                  <em>Get a pairing code</em>, then on your phone choose &ldquo;Link with phone number
                  instead&rdquo; and type the eight characters. Easier than aiming a camera at a
                  laptop.
                </li>
              </ul>
              <p>
                Codes expire after about twenty seconds and the page keeps making new ones, so take
                the one on screen rather than one you wrote down.
              </p>
              <Note title="Whose account?">
                <p>
                  The account you link becomes the identity the box sends as — voice notes from your
                  child will arrive at Grandma looking like they came from you. Plenty of families are
                  fine with that. If you would rather the box had its own name in everyone’s phone, use
                  a spare number or a cheap second SIM, and link that instead.
                </p>
              </Note>
            </Step>

            <Step n={11} title="Decide who lives behind each colour">
              <p>
                Still in the settings page, open <strong>Contacts</strong>. Three rows, one per
                button, in the order they sit on the box: <strong>1 is the left one</strong>, 2 the
                centre, 3 the right. Give each a name — that name is for you, the child navigates by
                colour — and point it at either:
              </p>
              <ul className={styles.list}>
                <li>
                  <strong>A phone number, with its country code.</strong> Write it however you like:{' '}
                  <code>+54 9 11 5555 5555</code>, <code>005491155555555</code> and{' '}
                  <code>5491155555555</code> are all read as the same person. A number with a leading
                  zero and no country code is rejected rather than guessed at — guessing would ring a
                  stranger.
                </li>
                <li>
                  <strong>A group,</strong> from the picker, which fills up once WhatsApp is linked.
                  Putting the family group on a button means everyone in it can reach your child, and
                  everyone in it hears what your child sends. That is usually exactly what you want
                  from &ldquo;the cousins&rdquo;, and it is worth deciding on purpose.
                </li>
              </ul>
              <p>
                <strong>Nobody else can get through.</strong> Unknown numbers, groups you did not
                choose, broadcasts and forwards are dropped before a single second of audio is
                downloaded.
              </p>
              <p>
                Save. The box restarts — that takes a few seconds and the page waits for it — and the
                lights go out. <strong>Dark is the ready state.</strong> Hand it to your child.
              </p>
            </Step>
          </div>
        </section>

        {/* ---- the lights: the page's one dark band ---- */}
        <section className={styles.night}>
          <div className="wrap">
            <p className={`eyebrow ${styles.nightEyebrow} rise`}>Keep this bit</p>
            <div className={`${styles.split} rise`}>
              <h2>What the lights are telling you.</h2>
              <p className="lede">
                Three lamps are the entire vocabulary of this device — there is no screen to explain
                itself with. These are the real patterns at the real speeds, so the difference that
                actually matters across a dark room is visible here: a blink is not a heartbeat.
                Most of the time they are off, which is the good news. The one rule worth
                memorising: <strong>solid always means something is wrong.</strong>
              </p>
            </div>

            <div className="rise">
              <LightSignature />
            </div>
          </div>
        </section>

        {/* ---- closing ---- */}
        <section className={`wrap ${styles.closing}`}>
          <img src="/bloopbox-logo-light.svg" alt="" className={styles.mark} />
          <h2 className={styles.closingTitle}>That’s the whole thing.</h2>
          <p className={styles.closingLede}>
            Hold a button to send, tap a lit one to hear what came back. Nothing else to teach, and
            nothing else to learn. If a step here was confusing or wrong, the manual is in the
            repository too — say so and it gets fixed.
          </p>
          <div className={styles.ctas}>
            <a className="btn btn-primary" href={links.repo}>
              Source and issues
            </a>
            <a className="btn btn-secondary" href={links.product}>
              What it does, precisely
            </a>
          </div>
        </section>
      </main>

      <SiteFooter />
    </>
  )
}
