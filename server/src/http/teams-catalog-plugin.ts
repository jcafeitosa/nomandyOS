import { Elysia } from "elysia";
import { catalogTeamListQuerySchema } from "@paperclipai/shared";
import { forbidden, unauthorized } from "../errors.js";
import type { HttpActor } from "./actor-context.js";
import { createHttpAuthorization } from "./authorization.js";
import { assertHttpAuthenticated } from "./actor-info.js";
import type { ActorResolver } from "./context.js";

export type TeamsCatalogPluginOptions = {
  resolveActor: ActorResolver;
  listCatalogTeams: (query: { kind?: string; category?: string; q?: string }) => Promise<unknown>;
  getCatalogTeamOrThrow: (catalogRef: string) => Promise<unknown>;
  listInstalledCatalogTeams: (companyId: string) => Promise<unknown>;
};

function firstQuery(url: URL, key: string): string | undefined {
  const value = url.searchParams.get(key);
  return value === null ? undefined : value;
}

async function resolveActor(
  options: TeamsCatalogPluginOptions,
  ctx: { request: Request; actor?: HttpActor },
): Promise<HttpActor> {
  const actor = ctx.actor ?? (await options.resolveActor(ctx.request));
  if (!actor) throw unauthorized();
  return actor;
}

export function createTeamsCatalogPlugin(options: TeamsCatalogPluginOptions) {
  return new Elysia({ name: "paperclip-teams-catalog" })
    .get("/api/teams/catalog", async (ctx) => {
      const actor = await resolveActor(options, ctx);
      assertHttpAuthenticated(actor);
      const url = new URL(ctx.request.url);
      const query = catalogTeamListQuerySchema.parse({
        kind: firstQuery(url, "kind"),
        category: firstQuery(url, "category"),
        q: firstQuery(url, "q"),
      });
      return options.listCatalogTeams(query);
    })
    .get("/api/teams/catalog/:catalogId", async (ctx) => {
      const actor = await resolveActor(options, ctx);
      assertHttpAuthenticated(actor);
      const url = new URL(ctx.request.url);
      const catalogRef = firstQuery(url, "ref") ?? ctx.params.catalogId;
      return options.getCatalogTeamOrThrow(catalogRef);
    })
    .get("/api/companies/:companyId/teams/catalog/installed", async (ctx) => {
      const actor = await resolveActor(options, ctx);
      createHttpAuthorization(actor, ctx.request.method).requireCompany(ctx.params.companyId);
      return options.listInstalledCatalogTeams(ctx.params.companyId);
    })
    ;
}
