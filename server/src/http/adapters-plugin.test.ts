import { describe, expect, it } from "bun:test";
import { createProtectedHttpApp } from "./app.js";
import type { HttpActor } from "./actor-context.js";
import { buildAdapterCapabilities } from "./adapters-plugin.js";
import type { ServerAdapterModule } from "../adapters/types.js";

const boardAdmin: HttpActor = {
  type: "board",
  source: "local_implicit",
  userId: "u1",
  isInstanceAdmin: true,
};

const boardMember: HttpActor = {
  type: "board",
  source: "session",
  userId: "u2",
  isInstanceAdmin: false,
  companyIds: ["c1"],
};

const agentActor = { type: "agent" as const, agentId: "a1" } as HttpActor;

function appFor(actor: HttpActor) {
  return createProtectedHttpApp({
    deploymentMode: "local_trusted",
    deploymentExposure: "private",
    authReady: true,
    resolveActor: async () => actor,
    adapters: { getNativeRunnerEnabled: async () => false },
  });
}

describe("buildAdapterCapabilities", () => {
  it("projects login scalars and drops callables", () => {
    const adapter = {
      type: "demo",
      supportsInstructionsBundle: true,
      supportsLocalAgentJwt: false,
      listSkills: async () => [],
      loginCapability: { panelMode: "modal", timeoutPolicy: "soft", start: async () => {} },
    } as unknown as ServerAdapterModule;
    expect(buildAdapterCapabilities(adapter)).toEqual({
      supportsInstructionsBundle: true,
      supportsSkills: true,
      supportsLocalAgentJwt: false,
      requiresMaterializedRuntimeSkills: false,
      supportsAcp: false,
      login: { panelMode: "modal", timeoutPolicy: "soft" },
    });
  });
});

describe("Elysia adapters plugin auth floors", () => {
  it("rejects non-board on GET /api/adapters with 403", async () => {
    expect((await appFor(agentActor).handle(new Request("http://localhost/api/adapters"))).status).toBe(403);
  });
  it("lists adapters for board member with 200", async () => {
    const res = await appFor(boardMember).handle(new Request("http://localhost/api/adapters"));
    expect(res.status).toBe(200);
    expect(Array.isArray(await res.json())).toBe(true);
  });
  it("requires instance admin for POST install with 403", async () => {
    const res = await appFor(boardMember).handle(new Request("http://localhost/api/adapters/install", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ packageName: "@scope/pkg" }) }));
    expect(res.status).toBe(403);
  });
  it("rejects install without packageName with 400", async () => {
    const res = await appFor(boardAdmin).handle(new Request("http://localhost/api/adapters/install", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}) }));
    expect(res.status).toBe(400);
  });
  it("returns 404 for unknown adapter type", async () => {
    expect((await appFor(boardMember).handle(new Request("http://localhost/api/adapters/__nom48_missing__"))).status).toBe(404);
  });
  it("requires instance admin for PATCH :type with 403", async () => {
    const res = await appFor(boardMember).handle(new Request("http://localhost/api/adapters/x", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ disabled: true }) }));
    expect(res.status).toBe(403);
  });
  it("requires instance admin for PATCH override with 403", async () => {
    const res = await appFor(boardMember).handle(new Request("http://localhost/api/adapters/x/override", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ paused: true }) }));
    expect(res.status).toBe(403);
  });
  it("requires instance admin for DELETE with 403", async () => {
    expect((await appFor(boardMember).handle(new Request("http://localhost/api/adapters/x", { method: "DELETE" }))).status).toBe(403);
  });
  it("requires instance admin for POST reload with 403", async () => {
    expect((await appFor(boardMember).handle(new Request("http://localhost/api/adapters/x/reload", { method: "POST" }))).status).toBe(403);
  });
  it("requires instance admin for POST reinstall with 403", async () => {
    expect((await appFor(boardMember).handle(new Request("http://localhost/api/adapters/x/reinstall", { method: "POST" }))).status).toBe(403);
  });
  it("requires board access for config-schema with 403", async () => {
    expect((await appFor(agentActor).handle(new Request("http://localhost/api/adapters/x/config-schema"))).status).toBe(403);
  });
  it("requires board access for ui-parser.js with 403", async () => {
    expect((await appFor(agentActor).handle(new Request("http://localhost/api/adapters/x/ui-parser.js"))).status).toBe(403);
  });
});

describe("Elysia adapters plugin lifecycle happy-path", () => {
  it("admin can disable then re-enable an existing adapter (200)", async () => {
    const app = appFor(boardAdmin);
    const listed = await (await app.handle(new Request("http://localhost/api/adapters"))).json() as Array<{ type: string }>;
    expect(listed.length).toBeGreaterThan(0);
    const type = listed[0]!.type;
    const disable = await app.handle(new Request(`http://localhost/api/adapters/${type}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ disabled: true }) }));
    expect(disable.status).toBe(200);
    expect(await disable.json()).toMatchObject({ type, disabled: true });
    const enable = await app.handle(new Request(`http://localhost/api/adapters/${type}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ disabled: false }) }));
    expect(enable.status).toBe(200);
    expect(await enable.json()).toMatchObject({ type, disabled: false });
  });
});

