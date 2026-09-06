import { Elysia, t } from "elysia";
import { createAgentSchema, updateAgentSchema } from "@paperclipai/shared";
import { badRequest, forbidden, notFound, unauthorized, unprocessable } from "../errors.js";
import type { HttpActor } from "./actor-context.js";
import { createHttpAuthorization } from "./authorization.js";
import { getAccessibleHttpResource } from "./accessible-resource.js";
import { getHttpActorInfo } from "./actor-info.js";
import type { ActorResolver } from "./context.js";

export type AgentRecord = {
  id: string;
  companyId: string;
  name: string;
  role?: string;
  status?: string;
  [key: string]: unknown;
};

export type AgentsPluginOptions = {
  resolveActor: ActorResolver;
  list: (companyId: string) => Promise<AgentRecord[]>;
  getById: (id: string) => Promise<AgentRecord | null>;
  create: (
    companyId: string,
    body: unknown,
    actor: HttpActor,
  ) => Promise<AgentRecord>;
  update: (
    id: string,
    body: unknown,
    actor: HttpActor,
  ) => Promise<AgentRecord | null>;
  remove: (id: string) => Promise<AgentRecord | null>;
  pause: (id: string) => Promise<AgentRecord | null>;
  resume: (id: string) => Promise<AgentRecord | null>;
  terminate: (id: string) => Promise<AgentRecord | null>;
  approve: (id: string) => Promise<AgentRecord | null>;
  clearError: (id: string) => Promise<AgentRecord | null>;
  /** Optional gate after company access — mirrors agents:create decision. */
  assertCanCreate?: (actor: HttpActor, companyId: string) => Promise<void>;
  /** Optional gate for update/resume — mirrors assertCanUpdateAgent. */
  assertCanUpdate?: (actor: HttpActor, agent: AgentRecord) => Promise<void>;
  /** Optional redaction for list/detail responses. */
  present?: (agent: AgentRecord, actor: HttpActor, view: "list" | "detail" | "self") => unknown;
  logActivity?: (input: Record<string, unknown>) => Promise<void>;
};

async function resolveActor(
  options: AgentsPluginOptions,
  ctx: { request: Request; actor?: HttpActor },
): Promise<HttpActor> {
  const actor = ctx.actor ?? (await options.resolveActor(ctx.request));
  if (!actor) throw unauthorized();
  return actor;
}

function assertBoard(actor: HttpActor): asserts actor is Extract<HttpActor, { type: "board" }> {
  if (actor.type !== "board") throw forbidden("Board access required");
}

function activityActor(actor: HttpActor) {
  const info = getHttpActorInfo(actor);
  return {
    actorType: info.actorType,
    actorId: info.actorId,
    agentId: info.agentId,
    runId: info.runId,
    agentApiKeyId: info.agentApiKeyId,
  };
}

function present(
  options: AgentsPluginOptions,
  agent: AgentRecord,
  actor: HttpActor,
  view: "list" | "detail" | "self",
) {
  return options.present ? options.present(agent, actor, view) : agent;
}

export function createAgentsPlugin(options: AgentsPluginOptions) {
  return new Elysia({ name: "paperclip-agents" })
    .get("/api/companies/:companyId/agents", async (ctx) => {
      const actor = await resolveActor(options, ctx);
      const companyId = ctx.params.companyId;
      createHttpAuthorization(actor, ctx.request.method).requireCompany(companyId);
      const url = new URL(ctx.request.url);
      const unsupported = [...url.searchParams.keys()].sort();
      if (unsupported.length > 0) {
        throw badRequest(
          `Unsupported query parameter${unsupported.length === 1 ? "" : "s"}: ${unsupported.join(", ")}`,
        );
      }
      const rows = await options.list(companyId);
      return rows.map((agent) => present(options, agent, actor, "list"));
    })
    .get("/api/agents/me", async (ctx) => {
      const actor = await resolveActor(options, ctx);
      if (actor.type !== "agent" || !actor.agentId) {
        throw unauthorized("Agent authentication required");
      }
      const agent = await options.getById(actor.agentId);
      if (!agent) throw notFound("Agent not found");
      createHttpAuthorization(actor, ctx.request.method).requireCompany(agent.companyId);
      return present(options, agent, actor, "self");
    })
    .get("/api/agents/:id", async (ctx) => {
      const actor = await resolveActor(options, ctx);
      const agent = await getAccessibleHttpResource(
        actor,
        ctx.request.method,
        options.getById(ctx.params.id),
        "Agent not found",
      );
      const view = actor.type === "agent" && actor.agentId === agent.id ? "self" : "detail";
      return present(options, agent, actor, view);
    })
    .post(
      "/api/companies/:companyId/agents",
      async (ctx) => {
        const actor = await resolveActor(options, ctx);
        const companyId = ctx.params.companyId;
        createHttpAuthorization(actor, ctx.request.method).requireCompany(companyId);
        await options.assertCanCreate?.(actor, companyId);
        const body = createAgentSchema.parse(ctx.body ?? {});
        const agent = await options.create(companyId, body, actor);
        await options.logActivity?.({
          companyId,
          ...activityActor(actor),
          action: "agent.created",
          entityType: "agent",
          entityId: agent.id,
          details: { name: agent.name, role: agent.role },
        });
        ctx.set.status = 201;
        return present(options, agent, actor, "detail");
      },
      { body: t.Any() },
    )
    .patch(
      "/api/agents/:id",
      async (ctx) => {
        const actor = await resolveActor(options, ctx);
        const existing = await getAccessibleHttpResource(
          actor,
          ctx.request.method,
          options.getById(ctx.params.id),
          "Agent not found",
        );
        const raw = (ctx.body ?? {}) as Record<string, unknown>;
        if (Object.prototype.hasOwnProperty.call(raw, "permissions")) {
          throw unprocessable("Use /api/agents/:id/permissions for permission changes");
        }
        await options.assertCanUpdate?.(actor, existing);
        const body = updateAgentSchema.parse(raw);
        const agent = await options.update(existing.id, body, actor);
        if (!agent) throw notFound("Agent not found");
        await options.logActivity?.({
          companyId: agent.companyId,
          ...activityActor(actor),
          action: "agent.updated",
          entityType: "agent",
          entityId: agent.id,
          details: body,
        });
        return present(options, agent, actor, "detail");
      },
      { body: t.Any() },
    )
    .post("/api/agents/:id/pause", async (ctx) => {
      const actor = await resolveActor(options, ctx);
      assertBoard(actor);
      const existing = await getAccessibleHttpResource(
        actor,
        ctx.request.method,
        options.getById(ctx.params.id),
        "Agent not found",
      );
      const agent = await options.pause(existing.id);
      if (!agent) throw notFound("Agent not found");
      await options.logActivity?.({
        companyId: agent.companyId,
        actorType: "user",
        actorId: actor.userId ?? "board",
        action: "agent.paused",
        entityType: "agent",
        entityId: agent.id,
      });
      return present(options, agent, actor, "detail");
    })
    .post("/api/agents/:id/resume", async (ctx) => {
      const actor = await resolveActor(options, ctx);
      const existing = await getAccessibleHttpResource(
        actor,
        ctx.request.method,
        options.getById(ctx.params.id),
        "Agent not found",
      );
      await options.assertCanUpdate?.(actor, existing);
      const agent = await options.resume(existing.id);
      if (!agent) throw notFound("Agent not found");
      await options.logActivity?.({
        companyId: agent.companyId,
        ...activityActor(actor),
        action: "agent.resumed",
        entityType: "agent",
        entityId: agent.id,
      });
      return present(options, agent, actor, "detail");
    })
    .post("/api/agents/:id/clear-error", async (ctx) => {
      const actor = await resolveActor(options, ctx);
      assertBoard(actor);
      const existing = await getAccessibleHttpResource(
        actor,
        ctx.request.method,
        options.getById(ctx.params.id),
        "Agent not found",
      );
      const agent = await options.clearError(existing.id);
      if (!agent) throw notFound("Agent not found");
      await options.logActivity?.({
        companyId: agent.companyId,
        actorType: "user",
        actorId: actor.userId ?? "board",
        action: "agent.error_cleared",
        entityType: "agent",
        entityId: agent.id,
      });
      return present(options, agent, actor, "detail");
    })
    .post("/api/agents/:id/approve", async (ctx) => {
      const actor = await resolveActor(options, ctx);
      assertBoard(actor);
      const existing = await getAccessibleHttpResource(
        actor,
        ctx.request.method,
        options.getById(ctx.params.id),
        "Agent not found",
      );
      const agent = await options.approve(existing.id);
      if (!agent) throw notFound("Agent not found");
      await options.logActivity?.({
        companyId: agent.companyId,
        actorType: "user",
        actorId: actor.userId ?? "board",
        action: "agent.approved",
        entityType: "agent",
        entityId: agent.id,
      });
      return present(options, agent, actor, "detail");
    })
    .post("/api/agents/:id/terminate", async (ctx) => {
      const actor = await resolveActor(options, ctx);
      assertBoard(actor);
      const existing = await getAccessibleHttpResource(
        actor,
        ctx.request.method,
        options.getById(ctx.params.id),
        "Agent not found",
      );
      const agent = await options.terminate(existing.id);
      if (!agent) throw notFound("Agent not found");
      await options.logActivity?.({
        companyId: agent.companyId,
        actorType: "user",
        actorId: actor.userId ?? "board",
        action: "agent.terminated",
        entityType: "agent",
        entityId: agent.id,
      });
      return present(options, agent, actor, "detail");
    })
    .delete("/api/agents/:id", async (ctx) => {
      const actor = await resolveActor(options, ctx);
      assertBoard(actor);
      const existing = await getAccessibleHttpResource(
        actor,
        ctx.request.method,
        options.getById(ctx.params.id),
        "Agent not found",
      );
      const agent = await options.remove(existing.id);
      if (!agent) throw notFound("Agent not found");
      await options.logActivity?.({
        companyId: agent.companyId,
        actorType: "user",
        actorId: actor.userId ?? "board",
        action: "agent.deleted",
        entityType: "agent",
        entityId: agent.id,
      });
      return { ok: true };
    });
}
