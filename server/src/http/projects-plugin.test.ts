import { describe, expect, it } from "bun:test";
import { createProtectedHttpApp } from "./app.js";

const board = {
  type: "board" as const,
  source: "local_implicit" as const,
  userId: "u1",
  isInstanceAdmin: true,
};

const project = { id: "p1", companyId: "c1", name: "Alpha" };
const workspace = { id: "w1", name: "main", cwd: "/tmp", isPrimary: true };

function projectsOpts(overrides: Record<string, unknown> = {}) {
  return {
    list: async () => [project],
    getById: async (id: string) => (id === "p1" ? project : null),
    create: async () => project,
    update: async () => ({ ...project, name: "Beta" }),
    remove: async () => project,
    listWorkspaces: async () => [workspace],
    createWorkspace: async () => workspace,
    updateWorkspace: async () => workspace,
    removeWorkspace: async () => workspace,
    ...overrides,
  };
}

describe("Elysia projects plugin", () => {
  it("lists projects with company access", async () => {
    const app = createProtectedHttpApp({
      deploymentMode: "local_trusted",
      deploymentExposure: "private",
      authReady: true,
      resolveActor: () => board,
      projects: projectsOpts(),
    });
    const response = await app.handle(new Request("http://localhost/api/companies/c1/projects"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([project]);
  });

  it("returns 404 for cross-tenant project get", async () => {
    const app = createProtectedHttpApp({
      deploymentMode: "authenticated",
      deploymentExposure: "private",
      authReady: true,
      resolveActor: () => ({
        type: "board" as const,
        source: "session" as const,
        userId: "u2",
        companyIds: ["other"],
      }),
      projects: projectsOpts(),
    });
    const response = await app.handle(new Request("http://localhost/api/projects/p1"));
    expect(response.status).toBe(404);
  });

  it("creates project with 201", async () => {
    const app = createProtectedHttpApp({
      deploymentMode: "local_trusted",
      deploymentExposure: "private",
      authReady: true,
      resolveActor: () => board,
      projects: projectsOpts(),
    });
    const response = await app.handle(
      new Request("http://localhost/api/companies/c1/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Alpha" }),
      }),
    );
    expect(response.status).toBe(201);
  });

  it("creates workspace with 201", async () => {
    const app = createProtectedHttpApp({
      deploymentMode: "local_trusted",
      deploymentExposure: "private",
      authReady: true,
      resolveActor: () => board,
      projects: projectsOpts(),
    });
    const response = await app.handle(
      new Request("http://localhost/api/projects/p1/workspaces", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "main", cwd: "/tmp" }),
      }),
    );
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual(workspace);
  });

  it("denies project:read when decideProjectRead rejects", async () => {
    const app = createProtectedHttpApp({
      deploymentMode: "local_trusted",
      deploymentExposure: "private",
      authReady: true,
      resolveActor: () => board,
      projects: projectsOpts({
        decideProjectRead: async () => ({ allowed: false }),
      }),
    });
    const response = await app.handle(new Request("http://localhost/api/projects/p1"));
    expect(response.status).toBe(403);
  });
});
