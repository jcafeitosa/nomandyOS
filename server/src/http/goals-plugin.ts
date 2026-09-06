import { Elysia, t } from "elysia";
import { createGoalSchema, updateGoalSchema } from "@paperclipai/shared";
import { notFound, unauthorized } from "../errors.js";
import type { HttpActor } from "./actor-context.js";
import { createHttpAuthorization } from "./authorization.js";
import { getAccessibleHttpResource } from "./accessible-resource.js";
import { getHttpActorInfo } from "./actor-info.js";
import type { ActorResolver } from "./context.js";

export type GoalRecord = {
  id: string;
  companyId: string;
  title: string;
  level?: string;
  [key: string]: unknown;
};

export type GoalsPluginOptions = {
  resolveActor: ActorResolver;
  list: (companyId: string) => Promise<unknown>;
  getById: (id: string) => Promise<GoalRecord | null>;
  create: (companyId: string, body: unknown) => Promise<GoalRecord>;
  update: (id: string, body: unknown) => Promise<GoalRecord | null>;
  remove: (id: string) => Promise<GoalRecord | null>;
  logActivity?: (input: Record<string, unknown>) => Promise<void>;
  trackGoalCreated?: (goal: GoalRecord) => void;
};

async function resolveActor(
  options: GoalsPluginOptions,
  ctx: { request: Request; actor?: HttpActor },
): Promise<HttpActor> {
  const actor = ctx.actor ?? (await options.resolveActor(ctx.request));
  if (!actor) throw unauthorized();
  return actor;
}

export function createGoalsPlugin(options: GoalsPluginOptions) {
  return new Elysia({ name: "paperclip-goals" })
    .get("/api/companies/:companyId/goals", async (ctx) => {
      const actor = await resolveActor(options, ctx);
      createHttpAuthorization(actor, ctx.request.method).requireCompany(ctx.params.companyId);
      return options.list(ctx.params.companyId);
    })
    .get("/api/goals/:id", async (ctx) => {
      const actor = await resolveActor(options, ctx);
      return getAccessibleHttpResource(
        actor,
        ctx.request.method,
        options.getById(ctx.params.id),
        "Goal not found",
      );
    })
    .post(
      "/api/companies/:companyId/goals",
      async (ctx) => {
        const actor = await resolveActor(options, ctx);
        const companyId = ctx.params.companyId;
        createHttpAuthorization(actor, ctx.request.method).requireCompany(companyId);
        const body = createGoalSchema.parse(ctx.body ?? {});
        const goal = await options.create(companyId, body);
        const info = getHttpActorInfo(actor);
        await options.logActivity?.({
          companyId,
          actorType: info.actorType,
          actorId: info.actorId,
          agentId: info.agentId,
          action: "goal.created",
          entityType: "goal",
          entityId: goal.id,
          details: { title: goal.title },
        });
        options.trackGoalCreated?.(goal);
        ctx.set.status = 201;
        return goal;
      },
      { body: t.Any() },
    )
    .patch(
      "/api/goals/:id",
      async (ctx) => {
        const actor = await resolveActor(options, ctx);
        const existing = await getAccessibleHttpResource(
          actor,
          ctx.request.method,
          options.getById(ctx.params.id),
          "Goal not found",
        );
        const body = updateGoalSchema.parse(ctx.body ?? {});
        const goal = await options.update(existing.id, body);
        if (!goal) throw notFound("Goal not found");
        const info = getHttpActorInfo(actor);
        await options.logActivity?.({
          companyId: goal.companyId,
          actorType: info.actorType,
          actorId: info.actorId,
          agentId: info.agentId,
          action: "goal.updated",
          entityType: "goal",
          entityId: goal.id,
          details: body,
        });
        return goal;
      },
      { body: t.Any() },
    )
    .delete("/api/goals/:id", async (ctx) => {
      const actor = await resolveActor(options, ctx);
      const existing = await getAccessibleHttpResource(
        actor,
        ctx.request.method,
        options.getById(ctx.params.id),
        "Goal not found",
      );
      const goal = await options.remove(existing.id);
      if (!goal) throw notFound("Goal not found");
      const info = getHttpActorInfo(actor);
      await options.logActivity?.({
        companyId: goal.companyId,
        actorType: info.actorType,
        actorId: info.actorId,
        agentId: info.agentId,
        action: "goal.deleted",
        entityType: "goal",
        entityId: goal.id,
      });
      return goal;
    });
}
