import { describe, expect, it } from "bun:test";
import { createProtectedHttpApp } from "./app.js";

const board = {
  type: "board" as const,
  source: "local_implicit" as const,
  userId: "u1",
  isInstanceAdmin: true,
};

const goal = { id: "g1", companyId: "c1", title: "Ship", level: "company" };

function goalsOpts(overrides: Record<string, unknown> = {}) {
  return {
    list: async () => [goal],
    getById: async (id: string) => (id === "g1" ? goal : null),
    create: async () => goal,
    update: async () => ({ ...goal, title: "Updated" }),
    remove: async () => goal,
    ...overrides,
  };
}

describe("Elysia goals plugin", () => {
  it("lists goals with company access", async () => {
    const app = createProtectedHttpApp({
      deploymentMode: "local_trusted",
      deploymentExposure: "private",
      authReady: true,
      resolveActor: () => board,
      goals: goalsOpts(),
    });
    const response = await app.handle(new Request("http://localhost/api/companies/c1/goals"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([goal]);
  });

  it("returns 404 for cross-tenant goal get (no existence oracle)", async () => {
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
      goals: goalsOpts(),
    });
    const response = await app.handle(new Request("http://localhost/api/goals/g1"));
    expect(response.status).toBe(404);
  });

  it("creates with 201", async () => {
    const app = createProtectedHttpApp({
      deploymentMode: "local_trusted",
      deploymentExposure: "private",
      authReady: true,
      resolveActor: () => board,
      goals: goalsOpts(),
    });
    const response = await app.handle(
      new Request("http://localhost/api/companies/c1/goals", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Ship", level: "company" }),
      }),
    );
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual(goal);
  });

  it("fails closed without actor", async () => {
    const app = createProtectedHttpApp({
      deploymentMode: "authenticated",
      deploymentExposure: "private",
      authReady: true,
      resolveActor: () => null,
      goals: goalsOpts(),
    });
    const response = await app.handle(new Request("http://localhost/api/companies/c1/goals"));
    expect(response.status).toBe(401);
  });
});
