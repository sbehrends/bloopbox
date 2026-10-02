/**
 * What of a WhatsApp address may reach a log.
 *
 * The journal leaves the device: `bloopbox-diagnostics` bundles it for whoever is helping, and
 * debug mode keeps more of it for longer. A phone number in it is a family member's number, so
 * the bridge logs a mask that still tells two contacts apart and matches what a parent sees in
 * the admin panel's ending digits — `+49•••4567` — and never the address itself.
 *
 * Groups and LIDs are not phone numbers, but they are stable identifiers of real people's chats,
 * so they get the same treatment.
 */
export function maskJid(jid: string | null | undefined): string | null {
  if (jid === null || jid === undefined || jid.length === 0) return null;
  const at = jid.indexOf('@');
  // A device suffix (`4915…:12@s.whatsapp.net`) says nothing about the person.
  const user = (at === -1 ? jid : jid.slice(0, at)).split(':', 1)[0] ?? '';
  const server = at === -1 ? '' : jid.slice(at + 1);
  const tail = user.length > 6 ? user.slice(-4) : '';
  switch (server) {
    case 's.whatsapp.net':
      return /^\d+$/.test(user) && tail !== '' ? `+${user.slice(0, 2)}•••${tail}` : '+•••';
    case 'lid':
      return `lid•••${tail}`;
    case 'g.us':
      return `group•••${tail}`;
    default:
      return `•••${tail}${server === '' ? '' : `@${server}`}`;
  }
}
