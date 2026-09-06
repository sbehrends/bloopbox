import { writeFile } from 'node:fs/promises';
import { NET_REQUEST_PATH } from '../net/netState.ts';

/**
 * Rebooting and shutting the box down, from a panel a parent can reach.
 *
 * The daemon runs unprivileged under `ProtectSystem=strict` and cannot talk to systemd, exactly
 * as it cannot talk to NetworkManager — so this takes the route that already exists for that:
 * it writes a request into its own runtime directory, and `deploy/net-agent.sh`, which is the
 * one thing in this product running as root, reads it, matches the action against a fixed list,
 * and acts. Nothing from this file is ever evaluated as shell.
 *
 * The same file as the network requests, deliberately. The rule that makes that channel safe is
 * **one writer per directory** (`docs/architecture.md` § Networking), and a second request file
 * beside the first would not add a boundary — the agent's allowlist is the boundary, and it is
 * one list. What is worth saying out loud is that the list is now wider than networking: an
 * action arriving there can power the device off.
 *
 * Why a parent needs it at all: the box has no power button and pulling the plug is what put an
 * unread voice note in RAM and lost it (`audio/directories.ts`). "Shut down, then unplug" is the
 * safe way to move a box between rooms, and this is the only place to ask for it.
 */

/** Everything this module may ask the root agent for. The agent enforces the same two names. */
export const POWER_ACTIONS = ['reboot', 'poweroff'] as const;

export type PowerAction = (typeof POWER_ACTIONS)[number];

export function isPowerAction(value: unknown): value is PowerAction {
  // Widened rather than narrowed: asserting the argument *into* the union is the assertion that
  // could lie, and this way the check is the only thing deciding.
  return typeof value === 'string' && (POWER_ACTIONS as readonly string[]).includes(value);
}

/**
 * Asks the agent to reboot or power off.
 *
 * Fire-and-forget like `requestNetAction`, and for the same reason: the answer is the machine
 * going away, not a return value. `true` means the request reached the file the agent reads —
 * on a development machine there is no agent and no runtime directory, so `false` there is
 * normal and is reported to the panel as "this box cannot do that", not as a failure.
 */
export async function requestPowerAction(
  action: PowerAction,
  options: { readonly path?: string } = {},
): Promise<boolean> {
  try {
    // Written whole in one call: the agent may read it at any moment, and half a document
    // parses as nothing and is dropped.
    await writeFile(options.path ?? NET_REQUEST_PATH, `${JSON.stringify({ action })}\n`, {
      mode: 0o640,
    });
    return true;
  } catch {
    return false;
  }
}
