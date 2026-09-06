import { describe, expect, it } from "bun:test";
import { createProtectedHttpApp } from "./app.js";
import { redactBuiltInAgentListState, type BuiltInAgentState } from "./built-in-agents-plugin.js";

const board = {
  type: "board" as const,
  source: "local_implicit" as const,
  userId: "u1",
  isInstanceAdmin: true,
};

const sampleState: BuiltInAgentState = {
  agentId: "a1",
  status: "ready",
  definition: {
    defaultInstructions: "SECRET PROMPT",
    bundle: {
      stockVersion: "1",
      instructions: { entryFile: "AGENTS.md", files: { "AGENTS.md": "x" } },
      skill: {
        skillKey: "s",
        displayName: "S",
        slug: "s",
        canonicalKey: "s",
        files: { "SKILL.md": "y" },
      },
      routine: {
        routineKey: "r",
        title: "R",
        status: "active",
        triggers: [{ cronExpression: "0 9 * * 1", timezone: "UTC" }],
      },
    },
  },
  agent: { adapterConfig: { token: "secret" }, runtimeConfig: { x: 1 }, name: "Bot" },
};

function builtInOpts(overrides: Record<string, unknown> = {}) {
  return {
    isBuiltInAgentsEnabled: async () => true,
    list: async () => [sampleState],
    get: async () => sampleState,
    ensure: async () => sampleState,
    provision: async () => ({ state: sampleState, approval: null }),
    reset: async () => sampleState,
    enableRoutineSchedule: async () => sampleState,
    disableRoutineSchedule: async () => sampleState,
    runRoutine: async () => ({ id: "run-1" }),
    decideAgentsCreate: async () => ({ allowed: true }),
    canUserAssignTasks: async () => true,
    ...overrides,
  };
}

describe("Elysia built-in agents plugin", () => {
  it("redacts instructions and adapter secrets on list", async () => {
    const redacted = redactBuiltInAgentListState(sampleState);
    expect(redacted.definition.defaultInstructions).toBe("[file-backed]");
    expect(redacted.agent?.adapterConfig).toEqual({});
    const routine = redacted.definition.bundle?.routine;
    expect(routine && "scheduleLabel" in routine ? routine.scheduleLabel : undefined).toContain("Mon");
  });

  it("lists built-in agents when enabled", async () => {
    const app = createProtectedHttpApp({
      deploymentMode: "local_trusted",
      deploymentExposure: "private",
      authReady: true,
      resolveActor: () => board,
      builtInAgents: builtInOpts(),
    });
    const response = await app.handle(new Request("http://localhost/api/companies/c1/built-in-agents"));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body[0].definition.defaultInstructions).toBe("[file-backed]");
    expect(body[0].agent.adapterConfig).toEqual({});
  });

  it("returns 404 when built-in agents are disabled", async () => {
    const app = createProtectedHttpApp({
      deploymentMode: "local_trusted",
      deploymentExposure: "private",
      authReady: true,
      resolveActor: () => board,
      builtInAgents: builtInOpts({ isBuiltInAgentsEnabled: async () => false }),
    });
    const response = await app.handle(new Request("http://localhost/api/companies/c1/built-in-agents"));
    expect(response.status).toBe(404);
  });

  it("denies provision without agents:create", async () => {
    const app = createProtectedHttpApp({
      deploymentMode: "local_trusted",
      deploymentExposure: "private",
      authReady: true,
      resolveActor: () => board,
      builtInAgents: builtInOpts({
        decideAgentsCreate: async () => ({ allowed: false, explanation: "Missing permission: agents:create" }),
      }),
    });
    const response = await app.handle(
      new Request("http://localhost/api/companies/c1/built-in-agents/ceo/provision", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      }),
    );
    expect(response.status).toBe(403);
  });

  it("returns 202 for routine run", async () => {
    const app = createProtectedHttpApp({
      deploymentMode: "local_trusted",
      deploymentExposure: "private",
      authReady: true,
      resolveActor: () => board,
      builtInAgents: builtInOpts(),
    });
    const response = await app.handle(
      new Request("http://localhost/api/companies/c1/built-in-agents/ceo/routines/weekly/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      }),
    );
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ id: "run-1" });
  });
});
