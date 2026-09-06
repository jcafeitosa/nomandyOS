import { describe, expect, it } from "bun:test";
import { createProtectedHttpApp } from "./app.js";
import type { AgentRecord } from "./agents-plugin.js";

const board = {
  type: "board" as const,
  source: "local_implicit" as const,
  userId: "u1",
  isInstanceAdmin: true,
};

const agentRow: AgentRecord = {
  id: "a1",
  companyId: "c1",
  name: "Jonas",
  role: "engineer",
  status: "idle",
};

function agentsOpts(overrides: Record<string, unknown> = {}) {
  return {
    list: async () => [agentRow],
    getById: async (id: string) => (id === "a1" ? agentRow : null),
    create: async () => agentRow,
    update: async () => ({ ...agentRow, name: "Updated" }),
    remove: async () => agentRow,
    pause: async () => ({ ...agentRow, status: "paused" }),
    resume: async () => ({ ...agentRow, status: "idle" }),
    terminate: async () => ({ ...agentRow, status: "terminated" }),
    approve: async () => ({ ...agentRow, status: "idle" }),
    clearError: async () => agentRow,
    ...overrides,
  };
}

describe("Elysia agents plugin", () => {
  it("lists agents with company access", async () => {
    const app = createProtectedHttpApp({
      deploymentMode: "local_trusted",
      deploymentExposure: "private",
      authReady: true,
      resolveActor: () => board,
      agents: agentsOpts(),
    });
    const response = await app.handle(new Request("http://localhost/api/companies/c1/agents"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([agentRow]);
  });

  it("rejects unsupported list query params with 400", async () => {
    const app = createProtectedHttpApp({
      deploymentMode: "local_trusted",
      deploymentExposure: "private",
      authReady: true,
      resolveActor: () => board,
      agents: agentsOpts(),
    });
    const response = await app.handle(
      new Request("http://localhost/api/companies/c1/agents?status=idle"),
    );
    expect(response.status).toBe(400);
  });

  it("returns 404 for cross-tenant agent get (no existence oracle)", async () => {
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
      agents: agentsOpts(),
    });
    const response = await app.handle(new Request("http://localhost/api/agents/a1"));
    expect(response.status).toBe(404);
  });

  it("enforces responsible-user intersection on agent write", async () => {
    const app = createProtectedHttpApp({
      deploymentMode: "authenticated",
      deploymentExposure: "private",
      authReady: true,
      resolveActor: () => ({
        type: "agent" as const,
        source: "agent_key" as const,
        agentId: "a1",
        companyId: "c1",
        onBehalfOfUserId: "u-resp",
        onBehalfOfMemberships: [
          { companyId: "c1", membershipRole: "viewer", status: "active" },
        ],
      }),
      agents: agentsOpts(),
    });
    const response = await app.handle(
      new Request("http://localhost/api/companies/c1/agents", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "New", adapterType: "process" }),
      }),
    );
    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error).toContain("Responsible user");
    expect(body.details?.code ?? body.code).toBeTruthy();
  });

  it("creates with 201 when authorized", async () => {
    const app = createProtectedHttpApp({
      deploymentMode: "local_trusted",
      deploymentExposure: "private",
      authReady: true,
      resolveActor: () => board,
      agents: agentsOpts(),
    });
    const response = await app.handle(
      new Request("http://localhost/api/companies/c1/agents", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "New", adapterType: "process" }),
      }),
    );
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual(agentRow);
  });

  it("gets agents/me for agent actor", async () => {
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
      agents: agentsOpts(),
    });
    const response = await app.handle(new Request("http://localhost/api/agents/me"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(agentRow);
  });

  it("rejects agents/me without agent auth", async () => {
    const app = createProtectedHttpApp({
      deploymentMode: "local_trusted",
      deploymentExposure: "private",
      authReady: true,
      resolveActor: () => board,
      agents: agentsOpts(),
    });
    const response = await app.handle(new Request("http://localhost/api/agents/me"));
    expect(response.status).toBe(401);
  });

  it("rejects permissions field on PATCH with 422", async () => {
    const app = createProtectedHttpApp({
      deploymentMode: "local_trusted",
      deploymentExposure: "private",
      authReady: true,
      resolveActor: () => board,
      agents: agentsOpts(),
    });
    const response = await app.handle(
      new Request("http://localhost/api/agents/a1", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ permissions: { canCreateAgents: true } }),
      }),
    );
    expect(response.status).toBe(422);
  });

  it("pauses and deletes require board", async () => {
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
      agents: agentsOpts(),
    });
    const pause = await app.handle(
      new Request("http://localhost/api/agents/a1/pause", { method: "POST" }),
    );
    expect(pause.status).toBe(403);
    const del = await app.handle(
      new Request("http://localhost/api/agents/a1", { method: "DELETE" }),
    );
    expect(del.status).toBe(403);
  });

  it("deletes with { ok: true }", async () => {
    const app = createProtectedHttpApp({
      deploymentMode: "local_trusted",
      deploymentExposure: "private",
      authReady: true,
      resolveActor: () => board,
      agents: agentsOpts(),
    });
    const response = await app.handle(
      new Request("http://localhost/api/agents/a1", { method: "DELETE" }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  it("fails closed without actor", async () => {
    const app = createProtectedHttpApp({
      deploymentMode: "authenticated",
      deploymentExposure: "private",
      authReady: true,
      resolveActor: () => null,
      agents: agentsOpts(),
    });
    const response = await app.handle(new Request("http://localhost/api/companies/c1/agents"));
    expect(response.status).toBe(401);
  });

  it("blocks cross-company agent key on list", async () => {
    const app = createProtectedHttpApp({
      deploymentMode: "authenticated",
      deploymentExposure: "private",
      authReady: true,
      resolveActor: () => ({
        type: "agent" as const,
        source: "agent_key" as const,
        agentId: "a9",
        companyId: "other",
      }),
      agents: agentsOpts(),
    });
    const response = await app.handle(new Request("http://localhost/api/companies/c1/agents"));
    expect(response.status).toBe(403);
  });
});
