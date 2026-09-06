import { Elysia } from "elysia";
import { AGENT_ICON_NAMES } from "@paperclipai/shared";
import { hermesGatewayAgentConfigurationDoc } from "../adapters/hermes-gateway-doc.js";
import { forbidden, unauthorized } from "../errors.js";
import type { HttpActor } from "./actor-context.js";
import type { ActorResolver } from "./context.js";

export type LlmPluginOptions = {
  resolveActor: ActorResolver;
  getAgentById: (id: string) => Promise<{ permissions?: Record<string, unknown> | null } | null>;
  listAdapters: () => Array<{ type: string; agentConfigurationDoc?: string }>;
  iconNames?: readonly string[];
};

const pluginOnlyAdapterDocs = new Map([["hermes_gateway", hermesGatewayAgentConfigurationDoc]]);

/** Express mounts llmRoutes at `/` and under `/api` — same relative paths. */
const LLM_ROUTE_PREFIXES = ["", "/api"] as const;

function assertCanRead(actor: HttpActor, agent: Awaited<ReturnType<LlmPluginOptions["getAgentById"]>>) {
  if (actor.type === "board") return;
  if (actor.type === "none" || (actor.type !== "agent")) throw unauthorized();
  if (!actor.agentId) throw forbidden("Board or permitted agent authentication required");
  if (!agent?.permissions || !Boolean(agent.permissions.canCreateAgents)) {
    throw forbidden("Missing permission to read agent configuration reflection");
  }
}

function textResponse(body: string, set: { headers: Record<string, string | number> }) {
  set.headers["content-type"] = "text/plain; charset=utf-8";
  return body;
}

function buildIndex(adapters: Array<{ type: string }>) {
  const sorted = [...adapters].sort((a, b) => a.type.localeCompare(b.type));
  return [
    "# Paperclip Agent Configuration Index",
    "",
    "Installed adapters:",
    ...sorted.map((a) => `- ${a.type}: /llms/agent-configuration/${a.type}.txt`),
    "",
    "Plugin-only adapter docs:",
    ...Array.from(pluginOnlyAdapterDocs.keys())
      .filter((type) => !sorted.some((a) => a.type === type))
      .map((type) => `- ${type}: /llms/agent-configuration/${type}.txt`),
    "",
    "Related API endpoints:",
    "- GET /api/companies/:companyId/agent-configurations",
    "- GET /api/agents/:id/configuration",
    "- POST /api/companies/:companyId/agent-hires",
    "",
    "Agent identity references:",
    "- GET /llms/agent-icons.txt",
    "",
    "Notes:",
    "- Sensitive values are redacted in configuration read APIs.",
    "- New hires may be created in pending_approval state depending on company settings.",
    "- Use the paperclip-create-agent skill for end-to-end hiring: adapter reflection, config comparison, instruction source selection, icon choice, desiredSkills, sourceIssueId/sourceIssueIds, and approval follow-up.",
    "- Timer heartbeats are opt-in for new hires. Leave runtimeConfig.heartbeat.enabled false unless the role truly needs scheduled work or the user explicitly asked for it.",
    "",
  ].join("\n");
}

function buildIcons(iconNames: readonly string[]) {
  return [
    "# Paperclip Agent Icon Names",
    "",
    "Set the `icon` field on hire/create payloads to one of:",
    ...iconNames.map((name) => `- ${name}`),
    "",
    "Example:",
    '{ "name": "SearchOps", "role": "researcher", "icon": "search" }',
    "",
    "",
  ].join("\n");
}

function adapterDoc(
  requestedPath: string,
  options: LlmPluginOptions,
  set: { status?: number | string; headers: Record<string, string | number> },
) {
  if (!/^[^/\\]+\.txt$/.test(requestedPath) || requestedPath === "..txt") {
    set.status = 404;
    return textResponse("Not Found", set);
  }
  const adapterType = requestedPath.slice(0, -".txt".length);
  const adapter = options.listAdapters().find((entry) => entry.type === adapterType);
  if (!adapter) {
    const doc = pluginOnlyAdapterDocs.get(adapterType);
    if (doc) return textResponse(doc, set);
    set.status = 404;
    return textResponse(`Unknown adapter type: ${adapterType}`, set);
  }
  return textResponse(
    adapter.agentConfigurationDoc ??
      `# ${adapterType} agent configuration\n\nNo adapter-specific documentation registered.`,
    set,
  );
}

/**
 * Read-only LLM reflection routes.
 *
 * Dual-mounted at `/llms/*` and `/api/llms/*` to match Express oracle
 * (`app.use(llmRoutes)` + `api.use(llmRoutes)`).
 *
 * Prefer a parent `actor` from `withActorContext` when present (NOM-34 dedupe);
 * otherwise call `resolveActor` (standalone plugin / unit tests).
 */
export function createLlmPlugin(options: LlmPluginOptions) {
  const app = new Elysia({ name: "paperclip-llms-read-only" }).resolve(
    { as: "scoped" },
    async (ctx: { request: Request; actor?: HttpActor }) => {
      const actor = ctx.actor ?? (await options.resolveActor(ctx.request));
      if (!actor) throw unauthorized();
      const agent =
        actor.type === "agent" && actor.agentId ? await options.getAgentById(actor.agentId) : null;
      assertCanRead(actor, agent);
      return { llmActor: actor };
    },
  );

  const icons = options.iconNames ?? AGENT_ICON_NAMES;

  for (const prefix of LLM_ROUTE_PREFIXES) {
    app
      .get(`${prefix}/llms/agent-configuration.txt`, ({ set }) =>
        textResponse(buildIndex(options.listAdapters()), set),
      )
      .get(`${prefix}/llms/agent-icons.txt`, ({ set }) => textResponse(buildIcons(icons), set))
      .get(`${prefix}/llms/agent-configuration/*`, ({ params, set }) =>
        adapterDoc(params["*"], options, set),
      );
  }

  return app;
}
