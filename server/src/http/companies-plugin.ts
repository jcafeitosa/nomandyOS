import { Elysia, t } from "elysia";
import {
  createCompanySchema,
  updateCompanyBrandingSchema,
  updateCompanySchema,
} from "@paperclipai/shared";
import { forbidden, notFound, unauthorized } from "../errors.js";
import type { HttpActor } from "./actor-context.js";
import { createHttpAuthorization } from "./authorization.js";
import { getHttpActorInfo } from "./actor-info.js";
import type { ActorResolver } from "./context.js";

export type CompanyRecord = {
  id: string;
  name: string;
  status?: string;
  budgetMonthlyCents?: number;
  feedbackDataSharingEnabled?: boolean;
  [key: string]: unknown;
};

export type CompaniesPluginOptions = {
  resolveActor: ActorResolver;
  list: () => Promise<CompanyRecord[]>;
  stats: () => Promise<Record<string, unknown>>;
  getById: (companyId: string) => Promise<CompanyRecord | null>;
  create: (input: Record<string, unknown>, actor: HttpActor) => Promise<CompanyRecord>;
  update: (
    companyId: string,
    body: Record<string, unknown>,
    actorInfo: ReturnType<typeof getHttpActorInfo>,
  ) => Promise<CompanyRecord | null>;
  archive: (
    companyId: string,
    actorInfo: ReturnType<typeof getHttpActorInfo>,
  ) => Promise<CompanyRecord | null>;
  remove: (companyId: string) => Promise<CompanyRecord | null>;
  getAgentById?: (id: string) => Promise<{ companyId: string; role?: string | null } | null>;
  isCloudManagedInstance?: () => boolean;
  logActivity?: (input: Record<string, unknown>) => Promise<void>;
};

async function resolveActor(
  options: CompaniesPluginOptions,
  ctx: { request: Request; actor?: HttpActor },
): Promise<HttpActor> {
  const actor = ctx.actor ?? (await options.resolveActor(ctx.request));
  if (!actor) throw unauthorized();
  return actor;
}

function assertBoard(actor: HttpActor): asserts actor is Extract<HttpActor, { type: "board" }> {
  if (actor.type !== "board") throw forbidden("Board access required");
}

function assertInstanceAdmin(actor: HttpActor) {
  assertBoard(actor);
  if (actor.source === "local_implicit" || actor.isInstanceAdmin) return;
  throw forbidden("Instance admin required");
}

async function assertSameCompanyCeoAgentOrBoard(
  options: CompaniesPluginOptions,
  actor: HttpActor,
  method: string,
  companyId: string,
  capability: string,
) {
  createHttpAuthorization(actor, method).requireCompany(companyId);
  if (actor.type === "board") return;
  if (actor.type !== "agent" || !actor.agentId) {
    throw forbidden("Agent authentication required");
  }
  const actorAgent = await options.getAgentById?.(actor.agentId);
  if (!actorAgent || actorAgent.companyId !== companyId) {
    throw forbidden("Agent key cannot access another company");
  }
  if (actorAgent.role !== "ceo") {
    throw forbidden(`Only CEO agents can manage ${capability}`);
  }
}

export function createCompaniesPlugin(options: CompaniesPluginOptions) {
  return new Elysia({ name: "paperclip-companies" })
    .get("/api/companies", async (ctx) => {
      const actor = await resolveActor(options, ctx);
      assertBoard(actor);
      const result = await options.list();
      if (actor.source === "local_implicit" || actor.isInstanceAdmin) return result;
      const allowed = new Set(actor.companyIds ?? []);
      return result.filter((company) => allowed.has(company.id));
    })
    .get("/api/companies/stats", async (ctx) => {
      const actor = await resolveActor(options, ctx);
      assertBoard(actor);
      const allowed =
        actor.source === "local_implicit" || actor.isInstanceAdmin
          ? null
          : new Set(actor.companyIds ?? []);
      const stats = await options.stats();
      if (!allowed) return stats;
      return Object.fromEntries(Object.entries(stats).filter(([companyId]) => allowed.has(companyId)));
    })
    .get("/api/companies/issues", async (ctx) => {
      await resolveActor(options, ctx);
      ctx.set.status = 400;
      return {
        error: "Missing companyId in path. Use /api/companies/{companyId}/issues.",
      };
    })
    .get("/api/companies/:companyId", async (ctx) => {
      const actor = await resolveActor(options, ctx);
      const companyId = ctx.params.companyId;
      createHttpAuthorization(actor, ctx.request.method).requireCompany(companyId);
      if (actor.type !== "agent") assertBoard(actor);
      const company = await options.getById(companyId);
      if (!company) throw notFound("Company not found");
      return company;
    })
    .post(
      "/api/companies",
      async (ctx) => {
        const actor = await resolveActor(options, ctx);
        assertBoard(actor);
        if (options.isCloudManagedInstance?.()) {
          throw forbidden("Company creation is managed by Paperclip Cloud", {
            code: "cloud_managed",
          });
        }
        assertInstanceAdmin(actor);
        const body = createCompanySchema.parse(ctx.body ?? {});
        const company = await options.create(body as Record<string, unknown>, actor);
        ctx.set.status = 201;
        return company;
      },
      { body: t.Any() },
    )
    .patch(
      "/api/companies/:companyId",
      async (ctx) => {
        const actor = await resolveActor(options, ctx);
        const companyId = ctx.params.companyId;
        await assertSameCompanyCeoAgentOrBoard(
          options,
          actor,
          ctx.request.method,
          companyId,
          "company settings",
        );
        const info = getHttpActorInfo(actor);
        const body =
          actor.type === "agent"
            ? (updateCompanyBrandingSchema.parse(ctx.body ?? {}) as Record<string, unknown>)
            : (updateCompanySchema.parse(ctx.body ?? {}) as Record<string, unknown>);
        const company = await options.update(companyId, body, info);
        if (!company) throw notFound("Company not found");
        return company;
      },
      { body: t.Any() },
    )
    .patch(
      "/api/companies/:companyId/branding",
      async (ctx) => {
        const actor = await resolveActor(options, ctx);
        const companyId = ctx.params.companyId;
        await assertSameCompanyCeoAgentOrBoard(
          options,
          actor,
          ctx.request.method,
          companyId,
          "company branding",
        );
        const body = updateCompanyBrandingSchema.parse(ctx.body ?? {}) as Record<string, unknown>;
        const company = await options.update(companyId, body, getHttpActorInfo(actor));
        if (!company) throw notFound("Company not found");
        const info = getHttpActorInfo(actor);
        await options.logActivity?.({
          companyId,
          actorType: info.actorType,
          actorId: info.actorId,
          agentId: info.agentId,
          runId: info.runId,
          agentApiKeyId: info.agentApiKeyId,
          action: "company.branding_updated",
          entityType: "company",
          entityId: companyId,
          details: body,
        });
        return company;
      },
      { body: t.Any() },
    )
    .post("/api/companies/:companyId/archive", async (ctx) => {
      const actor = await resolveActor(options, ctx);
      const companyId = ctx.params.companyId;
      createHttpAuthorization(actor, ctx.request.method).requireCompany(companyId);
      assertBoard(actor);
      const company = await options.archive(companyId, getHttpActorInfo(actor));
      if (!company) throw notFound("Company not found");
      return company;
    })
    .delete("/api/companies/:companyId", async (ctx) => {
      const actor = await resolveActor(options, ctx);
      const companyId = ctx.params.companyId;
      createHttpAuthorization(actor, ctx.request.method).requireCompany(companyId);
      assertBoard(actor);
      const company = await options.remove(companyId);
      if (!company) throw notFound("Company not found");
      return { ok: true };
    });
}
