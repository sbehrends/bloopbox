import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseSshAccess, readSshAccess } from '../system/sshAccess.ts';

/**
 * The record `deploy/ssh-password.sh` leaves for the admin panel.
 *
 * The file is written by root, but it is still input: whatever this returns is shown to a parent
 * as the way into their box, so a record that does not look like what the script writes is
 * refused rather than displayed.
 */

let workDir: string | null = null;

afterEach(async () => {
  if (workDir !== null) await rm(workDir, { recursive: true, force: true });
  workDir = null;
});

describe('parseSshAccess', () => {
  it('reads the two lines the script writes', () => {
    expect(parseSshAccess('user=bloop\npassword=Xy7kQ2mN4pR8sT\n')).toEqual({
      user: 'bloop',
      password: 'Xy7kQ2mN4pR8sT',
    });
  });

  it('refuses a record missing either field', () => {
    expect(parseSshAccess('user=bloop\n')).toBeNull();
    expect(parseSshAccess('password=Xy7kQ2mN4pR8sT\n')).toBeNull();
    expect(parseSshAccess('')).toBeNull();
  });

  it('refuses values the script could not have written', () => {
    expect(parseSshAccess('user=Root Admin\npassword=Xy7kQ2mN4pR8sT\n')).toBeNull();
    expect(parseSshAccess('user=bloop\npassword=short\n')).toBeNull();
    expect(parseSshAccess('user=bloop\npassword=<script>alert(1)</script>\n')).toBeNull();
  });
});

describe('readSshAccess', () => {
  it('reads the record from disk', async () => {
    workDir = await mkdtemp(join(tmpdir(), 'bloopbox-ssh-'));
    const path = join(workDir, 'ssh-password');
    await writeFile(path, 'user=bloop\npassword=Xy7kQ2mN4pR8sT\n');

    expect(await readSshAccess(path)).toEqual({ user: 'bloop', password: 'Xy7kQ2mN4pR8sT' });
  });

  it('reads a missing record as nothing to show', async () => {
    // Every tarball install, every image built with --password, and every development machine.
    workDir = await mkdtemp(join(tmpdir(), 'bloopbox-ssh-'));
    expect(await readSshAccess(join(workDir, 'absent'))).toBeNull();
  });
});
