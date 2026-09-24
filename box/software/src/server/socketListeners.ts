import type { Server as HttpServer } from 'node:http';
import type { Server as IoServer } from 'socket.io';

/**
 * Serves an existing Socket.io server on one more HTTP listener.
 *
 * The app answers on `:3000` and on the portal port (`:80`), and the address a parent is given is
 * `http://bloopbox.local` — the second one. Socket.io used to be attached only to the first, so
 * the panel's live status never connected at the address everybody actually uses.
 *
 * The *engine* is attached, not `io.attach()` called again: that builds a second engine and
 * repoints `io.engine` and `io.httpServer` at it, after which `io.close()` would close only the
 * newer listener and leave the first one's clients open. One engine means one set of namespaces,
 * rooms and broadcasts, whichever port a client came in on — the bridge's included.
 *
 * Closing `server` closes the shared engine, and every client with it. That is only ever done on
 * the way out.
 */
export function serveSocketsOn(io: IoServer, server: HttpServer): void {
  io.engine.attach(server, { path: io.path() });
}
