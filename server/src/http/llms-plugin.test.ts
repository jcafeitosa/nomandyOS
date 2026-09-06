import { describe, expect, it } from "bun:test";
import { Elysia } from "elysia";
import { createLlmPlugin } from "./llms-plugin.js";

const adapter = { type: "codex_local", agentConfigurationDoc: "# codex docs" };

function appFor(
  actor: unknown,
  agent: unknown = { permissions: { canCreateAgents: true } },
  adapters: Array<{ type: string; agentConfigurationDoc?: string }> = [adapter],
) {
  return new Elysia().use(createLlmPlugin({
    resolveActor: async () => actor as never,
    getAgentById: async () => agent as never,
    listAdapters: () => adapters,
    iconNames: ["search"],
  }));
}

describe("Elysia LLM read-only plugin", () => {
  it("matches the textual success contract for board actors", async () => {
    const response = await appFor({ type: "board" }).handle(new Request("http://localhost/llms/agent-configuration/codex_local.txt"));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/plain");
    expect(await response.text()).toBe("# codex docs");
  });

  it("allows only agents with canCreateAgents", async () => {
    const response = await appFor({ type: "agent", agentId: "a1" }).handle(new Request("http://localhost/llms/agent-icons.txt"));
    expect(response.status).toBe(200);
  });

  it("denies absent, invalid, missing, and unpermitted actors", async () => {
    for (const actor of [null, { type: "none" }, { type: "agent" }, { type: "agent", agentId: "a1" }]) {
      const response = await appFor(actor, { permissions: { canCreateAgents: false } }).handle(new Request("http://localhost/llms/agent-icons.txt"));
      expect(response.status).toBe(actor?.type === "agent" ? 403 : 401);
    }
  });

  it("returns index and icon documentation", async () => {
    const index = await appFor({ type: "board" }).handle(new Request("http://localhost/llms/agent-configuration.txt"));
    expect(index.status).toBe(200);
    expect(await index.text()).toContain("codex_local: /llms/agent-configuration/codex_local.txt");

    const icons = await appFor({ type: "board" }).handle(new Request("http://localhost/llms/agent-icons.txt"));
    expect(icons.status).toBe(200);
    expect(await icons.text()).toContain("- search");
  });

  it("serves plugin-only Hermes documentation and generic fallback documentation", async () => {
    const hermes = await appFor({ type: "board" }, undefined, []).handle(new Request("http://localhost/llms/agent-configuration/hermes_gateway.txt"));
    expect(hermes.status).toBe(200);
    expect(await hermes.text()).toContain("hermes_gateway agent configuration");

    const fallback = await appFor({ type: "board" }, undefined, [{ type: "custom" }]).handle(new Request("http://localhost/llms/agent-configuration/custom.txt"));
    expect(fallback.status).toBe(200);
    expect(await fallback.text()).toContain("No adapter-specific documentation registered.");
  });

  it("rejects malformed adapter configuration paths", async () => {
    for (const path of [
      "codex_local",
      "codex_local/extra.txt",
      "/",
      "codex_local\\extra.txt",
      "..",
      "../codex_local.txt",
    ]) {
      const response = await appFor({ type: "board" }).handle(new Request(`http://localhost/llms/agent-configuration/${path}`));
      expect(response.status).toBe(404);
    }
  });

  it("returns plain-text 404 for an unknown adapter", async () => {
    const response = await appFor({ type: "board" }).handle(new Request("http://localhost/llms/agent-configuration/unknown.txt"));
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("text/plain");
    expect(await response.text()).toBe("Unknown adapter type: unknown");
  });
  it("serves the same contract under /api/llms (Express dual-mount)", async () => {
    const response = await appFor({ type: "board" }).handle(
      new Request("http://localhost/api/llms/agent-configuration/codex_local.txt"),
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("# codex docs");
  });

});
