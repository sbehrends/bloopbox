import { readFile } from 'node:fs/promises';

/**
 * The ssh login this device made for itself on first boot.
 *
 * A flashed image carries no usable password — one image is copied onto many cards and, from
 * CI, published — so `deploy/ssh-password.sh` generates one per device, as root, before sshd
 * starts, and records it here. The daemon can read the record but not rewrite it (`0640
 * root:bloopbox`), and the only place it goes is the admin panel, behind the parent's own
 * password.
 *
 * Absent on a box installed from the tarball, where the login is whatever its owner set up, and
 * on an image built with an explicit `--password`. Both read as `null`: nothing to show, not an
 * error.
 */

export const SSH_PASSWORD_PATH = process.env['SSH_PASSWORD_PATH'] ?? '/data/ssh-password';

export type SshAccess = {
  readonly user: string;
  readonly password: string;
};

/** The same user-name rule `ssh-password.sh` enforces before handing the name to chpasswd. */
const USER_PATTERN = /^[a-z_][a-z0-9_-]{0,31}$/;
/** What the script generates. Anything else in the file did not come from it. */
const PASSWORD_PATTERN = /^[A-Za-z0-9]{8,64}$/;

/** `user=…` and `password=…`, one per line. Strict: a record that does not parse is not shown. */
export function parseSshAccess(text: string): SshAccess | null {
  const fields = new Map<string, string>();
  for (const line of text.split('\n')) {
    const separator = line.indexOf('=');
    if (separator === -1) continue;
    fields.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
  }
  const user = fields.get('user');
  const password = fields.get('password');
  if (user === undefined || !USER_PATTERN.test(user)) return null;
  if (password === undefined || !PASSWORD_PATTERN.test(password)) return null;
  return { user, password };
}

export async function readSshAccess(path: string = SSH_PASSWORD_PATH): Promise<SshAccess | null> {
  try {
    return parseSshAccess(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}
