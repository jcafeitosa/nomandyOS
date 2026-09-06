import { describe, expect, it } from "bun:test";
import { createProtectedHttpApp } from "./app.js";

const board = {
  type: "board" as const,
  source: "local_implicit" as const,
  userId: "u1",
  userName: "U",
  isInstanceAdmin: true,
};

const folder = {
  id: "f1",
  kind: "skill",
  name: "My",
  path: "/my",
  parentId: null,
  position: 0,
  systemKey: "personal:u1",
};

function foldersOpts(overrides: Record<string, unknown> = {}) {
  return {
    list: async () => [folder],
    create: async () => folder,
    ensureMyFolder: async () => folder,
    update: async () => folder,
    moveItem: async () => ({ itemId: "i1", kind: "skill", folderId: "f1" }),
    moveFolder: async () => folder,
    deleteFolder: async () => folder,
    ...overrides,
  };
}

describe("Elysia folders plugin", () => {
  it("lists folders when kind is present", async () => {
    const app = createProtectedHttpApp({
      deploymentMode: "local_trusted",
      deploymentExposure: "private",
      authReady: true,
      resolveActor: () => board,
      folders: foldersOpts(),
    });
    const response = await app.handle(
      new Request("http://localhost/api/companies/c1/folders?kind=skill"),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([folder]);
  });

  it("rejects missing kind with 400", async () => {
    const app = createProtectedHttpApp({
      deploymentMode: "local_trusted",
      deploymentExposure: "private",
      authReady: true,
      resolveActor: () => board,
      folders: foldersOpts(),
    });
    const response = await app.handle(new Request("http://localhost/api/companies/c1/folders"));
    expect(response.status).toBe(400);
  });

  it("creates folder with 201", async () => {
    const app = createProtectedHttpApp({
      deploymentMode: "local_trusted",
      deploymentExposure: "private",
      authReady: true,
      resolveActor: () => board,
      folders: foldersOpts(),
    });
    const response = await app.handle(
      new Request("http://localhost/api/companies/c1/folders", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "skill", name: "My" }),
      }),
    );
    expect(response.status).toBe(201);
  });

  it("denies ensure-my for agents", async () => {
    const app = createProtectedHttpApp({
      deploymentMode: "local_trusted",
      deploymentExposure: "private",
      authReady: true,
      resolveActor: () => ({
        type: "agent" as const,
        source: "agent_key" as const,
        agentId: "a1",
        companyId: "c1",
      }),
      folders: foldersOpts(),
    });
    const response = await app.handle(
      new Request("http://localhost/api/companies/c1/folders/ensure-my", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      }),
    );
    expect(response.status).toBe(403);
  });
});
