import type { RequestHandler } from 'express';

/**
 * Cross-site request forgery and clickjacking defences for the admin API.
 *
 * The panel authenticates with HTTP Basic, and a browser that has the password saved attaches it
 * to **any** request for the box's origin — including one a page on some other website makes.
 * Several routes take no body at all (`/factory-reset`, `/whatsapp/unlink`, `/stats/reset`,
 * `/silent`, `/system/power`…), so a plain `<form method=post>` elsewhere on the internet could
 * wipe the device or unlink the family's WhatsApp while a parent browsed. There are no cookies
 * to mark `SameSite`, so the defence has to be on the request itself.
 */

/** Methods that never change state here, and so need no origin check. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Refuses a state-changing request that did not come from a page this box served.
 *
 * Three independent tests, any one of which catches a forged request:
 *
 *  - `Sec-Fetch-Site: cross-site` — every current browser sends it and a page cannot suppress it.
 *    `same-site` is allowed: `:80` and `:3000` on one host are the same site, and both are ours.
 *  - An `Origin` whose host is not the `Host` the request was sent to. Browsers attach `Origin`
 *    to every cross-origin POST; an absent one is a non-browser client (curl, the tests), which
 *    CSRF is not about. `Origin: null` — a sandboxed frame or a `file:` page — is refused.
 *  - A body that is not `application/json`. An HTML form can only send urlencoded, multipart or
 *    text/plain, and a cross-site `fetch` with a JSON type needs a CORS preflight this server
 *    never answers. That is what closes the body-less routes, which is why the browser callers
 *    send `content-type: application/json` even with an empty `{}`.
 */
export function requireSameOrigin(): RequestHandler {
  return (req, res, next) => {
    if (SAFE_METHODS.has(req.method)) {
      next();
      return;
    }

    if (req.get('sec-fetch-site') === 'cross-site') {
      res.status(403).json({ error: 'cross-site requests are not accepted' });
      return;
    }

    const origin = req.get('origin');
    if (origin !== undefined && originHost(origin) !== req.get('host')) {
      res.status(403).json({ error: 'cross-origin requests are not accepted' });
      return;
    }

    // The header itself rather than `req.is()`, which answers null for a request with no body
    // and would refuse a body-less POST however it was labelled.
    const mediaType = (req.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase();
    if (mediaType !== 'application/json') {
      res.status(415).json({ error: 'requests must be sent as application/json' });
      return;
    }

    next();
  };
}

/** `host[:port]` of an Origin header, or null for `null` and anything unparseable. */
function originHost(origin: string): string | null {
  try {
    return new URL(origin).host;
  } catch {
    return null;
  }
}

/**
 * Forbids framing, so the panel cannot be laid invisibly under another site's page and clicked
 * through (the factory reset is a single confirm dialog away). Both headers: `frame-ancestors`
 * is the standard, `X-Frame-Options` is what older WebViews — a captive-portal sheet among them —
 * still read. Nothing of ours frames anything, so there is no exception to make.
 */
export function denyFraming(): RequestHandler {
  return (_req, res, next) => {
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
    next();
  };
}
