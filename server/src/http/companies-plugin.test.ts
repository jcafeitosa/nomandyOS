import { describe, expect, it } from "bun:test";
import { createProtectedHttpApp } from "./app.js";

const board = {
  type: "board" as const,
  source: "local_implicit" as const,
  userId: "u1",
  isInstanceAdmin: true,
};

const company = { id: "c1", name: "Acme", status: "active", budgetMonthlyCents: 0 };

function companiesOpts(overrides: Record<string, unknown> = {}) {
  return {
    list: async () => [company],
    stats: async () => ({ c1: { agents: 1 } }),
    getById: async (id: string) => (id === "c1" ? company : null),
    create: async () => company,
    update: async () => company,
    archive: async () => ({ ...company, status: "archived" }),
    remove: async () => company,
    getAgentById: async () => null,
    isCloudManagedInstance: () => false,
    ...overrides,
  };
}

describe("Elysia companies plugin", () => {
  it("lists companies for board", async () => {
    const app = createProtectedHttpApp({
      deploymentMode: "local_trusted",
      deploymentExposure: "private",
      authReady: true,
      resolveActor: () => board,
      companies: companiesOpts(),
    });
    const response = await app.handle(new Request("http://localhost/api/companies"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([company]);
  });

  it("filters list by membership for non-admin session", async () => {
    const app = createProtectedHttpApp({
      deploymentMode: "authenticated",
      deploymentExposure: "private",
      authReady: true,
      resolveActor: () => ({
        type: "board" as const,
        source: "session" as const,
        userId: "u2",
        companyIds: ["c1"],
        isInstanceAdmin: false,
      }),
      companies: companiesOpts({
        list: async () => [company, { id: "c2", name: "Other" }],
      }),
    });
    const response = await app.handle(new Request("http://localhost/api/companies"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([company]);
  });

  it("gets company with requireCompany", async () => {
    const app = createProtectedHttpApp({
      deploymentMode: "local_trusted",
      deploymentExposure: "private",
      authReady: true,
      resolveActor: () => board,
      companies: companiesOpts(),
    });
    const response = await app.handle(new Request("http://localhost/api/companies/c1"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(company);
  });

  it("creates with 201 for instance admin", async () => {
    const app = createProtectedHttpApp({
      deploymentMode: "local_trusted",
      deploymentExposure: "private",
      authReady: true,
      resolveActor: () => board,
      companies: companiesOpts(),
    });
    const response = await app.handle(
      new Request("http://localhost/api/companies", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Acme" }),
      }),
    );
    expect(response.status).toBe(201);
  });

  it("rejects agent list with board required", async () => {
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
      companies: companiesOpts(),
    });
    const response = await app.handle(new Request("http://localhost/api/companies"));
    expect(response.status).toBe(403);
  });

  it("archives with company scope", async () => {
    const app = createProtectedHttpApp({
      deploymentMode: "local_trusted",
      deploymentExposure: "private",
      authReady: true,
      resolveActor: () => board,
      companies: companiesOpts(),
    });
    const response = await app.handle(
      new Request("http://localhost/api/companies/c1/archive", { method: "POST" }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "archived" });
  });
});
