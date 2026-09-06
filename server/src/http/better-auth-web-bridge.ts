/**
 * Typed Web Request/Response bridge for Better Auth on the Elysia boundary.
 *
 * Express continues to use `toNodeHandler` (oracle). This bridge is the native
 * Fetch path: method gate, optional trusted-origin check, passthrough cookies
 * via the handler Response, and redacted failures (no secret leakage).
 */

export type BetterAuthWebHandler = {
  handler: (request: Request) => Response | Promise<Response>;
};

export type BetterAuthWebBridgeOptions = {
  /** When non-empty, browser Origin must match one entry (mutating/CORS callers). */
  trustedOrigins?: readonly string[];
};

const ALLOWED_METHODS = new Set(["GET", "POST"]);

export function isTrustedAuthOrigin(
  origin: string | null,
  trustedOrigins: readonly string[],
): boolean {
  if (!origin) return true;
  if (trustedOrigins.length === 0) return true;
  return trustedOrigins.includes(origin);
}

/**
 * Forward a Web Request to Better Auth's Fetch handler with transport guards.
 * Set-Cookie and other headers from Better Auth pass through unchanged.
 */
export async function handleBetterAuthWebRequest(
  auth: BetterAuthWebHandler,
  request: Request,
  options: BetterAuthWebBridgeOptions = {},
): Promise<Response> {
  if (!ALLOWED_METHODS.has(request.method)) {
    return Response.json({ error: "Method Not Allowed" }, { status: 405 });
  }

  const trustedOrigins = options.trustedOrigins;
  if (trustedOrigins && trustedOrigins.length > 0) {
    const origin = request.headers.get("origin");
    if (!isTrustedAuthOrigin(origin, trustedOrigins)) {
      return Response.json({ error: "Forbidden" }, { status: 403 });
    }
  }

  try {
    return await auth.handler(request);
  } catch {
    return Response.json(
      { error: "Internal server error" },
      { status: 500, headers: { "cache-control": "no-store" } },
    );
  }
}
