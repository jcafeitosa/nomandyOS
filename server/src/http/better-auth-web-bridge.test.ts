import { describe, expect, it } from "bun:test";
import {
  handleBetterAuthWebRequest,
  isTrustedAuthOrigin,
} from "./better-auth-web-bridge.js";

describe("Better Auth Web Request/Response bridge", () => {
  it("allows only GET and POST", async () => {
    const auth = {
      handler: async () => new Response("ok"),
    };
    for (const method of ["PUT", "PATCH", "DELETE", "OPTIONS"]) {
      const response = await handleBetterAuthWebRequest(
        auth,
        new Request("http://localhost/api/auth/get-session", { method }),
      );
      expect(response.status).toBe(405);
      expect(await response.json()).toEqual({ error: "Method Not Allowed" });
    }
  });

  it("rejects disallowed Origin when trustedOrigins is set", async () => {
    let called = 0;
    const auth = {
      handler: async () => {
        called += 1;
        return new Response("ok");
      },
    };
    const response = await handleBetterAuthWebRequest(
      auth,
      new Request("http://localhost/api/auth/sign-in/email", {
        method: "POST",
        headers: { origin: "https://evil.example" },
      }),
      { trustedOrigins: ["http://localhost"] },
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "Forbidden" });
    expect(called).toBe(0);
  });

  it("passes through handler Response including Set-Cookie", async () => {
    const auth = {
      handler: async () =>
        new Response(JSON.stringify({ user: { email: "a@b.test" } }), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "set-cookie": "paperclip-default.session_token=abc; Path=/; HttpOnly",
          },
        }),
    };
    const response = await handleBetterAuthWebRequest(
      auth,
      new Request("http://localhost/api/auth/get-session", {
        method: "GET",
        headers: { origin: "http://localhost" },
      }),
      { trustedOrigins: ["http://localhost"] },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain("session_token=abc");
    expect(await response.json()).toEqual({ user: { email: "a@b.test" } });
  });

  it("redacts unexpected handler failures", async () => {
    const auth = {
      handler: async () => {
        throw new Error("BETTER_AUTH_SECRET=super-secret leaked");
      },
    };
    const response = await handleBetterAuthWebRequest(
      auth,
      new Request("http://localhost/api/auth/get-session", { method: "GET" }),
    );
    expect(response.status).toBe(500);
    const body = await response.text();
    expect(body).toBe(JSON.stringify({ error: "Internal server error" }));
    expect(body).not.toContain("super-secret");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("isTrustedAuthOrigin treats missing origin as allowed", () => {
    expect(isTrustedAuthOrigin(null, ["http://localhost"])).toBe(true);
    expect(isTrustedAuthOrigin("http://localhost", ["http://localhost"])).toBe(true);
    expect(isTrustedAuthOrigin("https://evil.example", ["http://localhost"])).toBe(false);
  });
});
