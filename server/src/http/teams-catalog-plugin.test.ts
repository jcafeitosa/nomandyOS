import { describe, expect, it } from "bun:test";
import { createProtectedHttpApp } from "./app.js";
import { notFound } from "../errors.js";

const board = {
  type: "board" as const,
  source: "local_implicit" as const,
  userId: "u1",
  isInstanceAdmin: true,
};

function teamsOpts(overrides: Record<string, unknown> = {}) {
  return {
    listCatalogTeams: async () => [{ id: "t1" }],
    getCatalogTeamOrThrow: async () => ({ id: "t1" }),
    listInstalledCatalogTeams: async () => [{ id: "installed" }],
    ...overrides,
  };
}

describe("Elysia teams catalog plugin", () => {
  it("lists catalog when authenticated", async () => {
    const app = createProtectedHttpApp({
      deploymentMode: "local_trusted",
      deploymentExposure: "private",
      authReady: true,
      resolveActor: () => board,
      teamsCatalog: teamsOpts(),
    });
    const response = await app.handle(new Request("http://localhost/api/teams/catalog"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([{ id: "t1" }]);
  });

  it("fails closed without actor", async () => {
    const app = createProtectedHttpApp({
      deploymentMode: "authenticated",
      deploymentExposure: "private",
      authReady: true,
      resolveActor: () => null,
      teamsCatalog: teamsOpts(),
    });
    const response = await app.handle(new Request("http://localhost/api/teams/catalog"));
    expect(response.status).toBe(401);
  });

  it("lists installed teams with company access", async () => {
    const app = createProtectedHttpApp({
      deploymentMode: "local_trusted",
      deploymentExposure: "private",
      authReady: true,
      resolveActor: () => board,
      teamsCatalog: teamsOpts(),
    });
    const response = await app.handle(
      new Request("http://localhost/api/companies/c1/teams/catalog/installed"),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([{ id: "installed" }]);
  });

  it("returns 404 for an unknown catalog route", async () => {
    const app = createProtectedHttpApp({
      deploymentMode: "local_trusted",
      deploymentExposure: "private",
      authReady: true,
      resolveActor: () => board,
      teamsCatalog: teamsOpts({
        getCatalogTeamOrThrow: async () => {
          throw notFound();
        },
      }),
    });
    const response = await app.handle(new Request("http://localhost/api/teams/catalog/missing"));
    expect(response.status).toBe(404);
  });

  it("passes kind, category, and q filters without invoking mutations", async () => {
    const calls = { list: 0 };
    const app = createProtectedHttpApp({
      deploymentMode: "local_trusted",
      deploymentExposure: "private",
      authReady: true,
      resolveActor: () => board,
      teamsCatalog: teamsOpts({
        listCatalogTeams: async (query: { kind?: string; category?: string; q?: string }) => {
          calls.list += 1;
          expect(query).toEqual({ kind: "bundled", category: "platform", q: "bun" });
          return [{ id: "filtered" }];
        },
      }),
    });
    const response = await app.handle(new Request("http://localhost/api/teams/catalog?kind=bundled&category=platform&q=bun"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([{ id: "filtered" }]);
    expect(calls).toEqual({ list: 1 });
  });

  it("keeps catalog reads isolated from company mutations", async () => {
    const calls = { list: 0, installed: 0 };
    const app = createProtectedHttpApp({
      deploymentMode: "local_trusted",
      deploymentExposure: "private",
      authReady: true,
      resolveActor: () => board,
      teamsCatalog: teamsOpts({
        listCatalogTeams: async () => { calls.list += 1; return []; },
        listInstalledCatalogTeams: async () => { calls.installed += 1; return []; },
      }),
    });
    expect((await app.handle(new Request("http://localhost/api/teams/catalog"))).status).toBe(200);
    expect((await app.handle(new Request("http://localhost/api/companies/c1/teams/catalog/installed"))).status).toBe(200);
    expect(calls).toEqual({ list: 1, installed: 1 });
  });

  it("returns 404 for removed mutating catalog routes", async () => {
    const app = createProtectedHttpApp({
      deploymentMode: "local_trusted",
      deploymentExposure: "private",
      authReady: true,
      resolveActor: () => board,
      teamsCatalog: teamsOpts(),
    });
    for (const [path, method] of [
      ["/api/teams/catalog/team-a/files", "GET"],
      ["/api/companies/c1/teams/catalog/team-a/preview", "POST"],
      ["/api/companies/c1/teams/catalog/team-a/install", "POST"],
    ] as const) {
      expect((await app.handle(new Request(`http://localhost${path}`, { method }))).status).toBe(404);
    }
  });

  it("does not expose removed mutation seams", async () => {
    const app = createProtectedHttpApp({
      deploymentMode: "local_trusted",
      deploymentExposure: "private",
      authReady: true,
      resolveActor: () => board,
      teamsCatalog: teamsOpts(),
    });
    const response = await app.handle(
      new Request("http://localhost/api/companies/c1/teams/catalog/team-a/install", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      }),
    );
    expect(response.status).toBe(404);
  });
});
