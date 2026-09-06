import { Elysia, t } from "elysia";
import {
  createProjectSchema,
  createProjectWorkspaceSchema,
  updateProjectSchema,
  updateProjectWorkspaceSchema,
} from "@paperclipai/shared";
import { forbidden, notFound, unauthorized, unprocessable } from "../errors.js";
import type { HttpActor } from "./actor-context.js";
import { createHttpAuthorization } from "./authorization.js";
import { getAccessibleHttpResource } from "./accessible-resource.js";
import { getHttpActorInfo } from "./actor-info.js";
import type { ActorResolver } from "./context.js";

export type ProjectRecord = {
  id: string;
  companyId: string;
  name?: string;
  env?: Record<string, unknown> | null;
  [key: string]: unknown;
};

export type ProjectsPluginOptions = {
  resolveActor: ActorResolver;
  list: (companyId: string, opts: { includeArchived: boolean }) => Promise<ProjectRecord[]>;
  getById: (id: string) => Promise<ProjectRecord | null>;
  create: (
    companyId: string,
    body: unknown,
    actor: HttpActor,
  ) => Promise<ProjectRecord>;
  update: (id: string, body: unknown, actor: HttpActor) => Promise<ProjectRecord | null>;
  remove: (id: string) => Promise<ProjectRecord | null>;
  listWorkspaces: (projectId: string) => Promise<unknown>;
  createWorkspace: (projectId: string, body: unknown) => Promise<unknown | null>;
  updateWorkspace: (
    projectId: string,
    workspaceId: string,
    body: unknown,
  ) => Promise<unknown | null>;
  removeWorkspace: (projectId: string, workspaceId: string) => Promise<unknown | null>;
  /** Optional project:read filter; default allows all listed rows. */
  decideProjectRead?: (input: {
    actor: HttpActor;
    project: ProjectRecord;
  }) => Promise<{ allowed: boolean }>;
  logActivity?: (input: Record<string, unknown>) => Promise<void>;
  trackProjectCreated?: () => void;
};

async function resolveActor(
  options: ProjectsPluginOptions,
  ctx: { request: Request; actor?: HttpActor },
): Promise<HttpActor> {
  const actor = ctx.actor ?? (await options.resolveActor(ctx.request));
  if (!actor) throw unauthorized();
  return actor;
}

function firstQuery(url: URL, key: string): string | undefined {
  const value = url.searchParams.get(key);
  return value === null ? undefined : value;
}

async function filterProjectsForActor(
  options: ProjectsPluginOptions,
  actor: HttpActor,
  rows: ProjectRecord[],
) {
  if (!options.decideProjectRead) return rows;
  const decisions = await Promise.all(
    rows.map((project) => options.decideProjectRead!({ actor, project })),
  );
  return rows.filter((_, index) => decisions[index]?.allowed);
}

async function assertProjectReadAllowed(
  options: ProjectsPluginOptions,
  actor: HttpActor,
  project: ProjectRecord,
) {
  if (!options.decideProjectRead) return;
  const decision = await options.decideProjectRead({ actor, project });
  if (!decision.allowed) {
    throw forbidden("Project is outside this actor's authorization boundary");
  }
}

export function createProjectsPlugin(options: ProjectsPluginOptions) {
  return new Elysia({ name: "paperclip-projects" })
    .get("/api/companies/:companyId/projects", async (ctx) => {
      const actor = await resolveActor(options, ctx);
      const companyId = ctx.params.companyId;
      createHttpAuthorization(actor, ctx.request.method).requireCompany(companyId);
      const url = new URL(ctx.request.url);
      const includeArchived = firstQuery(url, "includeArchived") === "true";
      const result = await options.list(companyId, { includeArchived });
      return filterProjectsForActor(options, actor, result);
    })
    .get("/api/projects/:id", async (ctx) => {
      const actor = await resolveActor(options, ctx);
      const project = await getAccessibleHttpResource(
        actor,
        ctx.request.method,
        options.getById(ctx.params.id),
        "Project not found",
      );
      await assertProjectReadAllowed(options, actor, project);
      return project;
    })
    .post(
      "/api/companies/:companyId/projects",
      async (ctx) => {
        const actor = await resolveActor(options, ctx);
        const companyId = ctx.params.companyId;
        createHttpAuthorization(actor, ctx.request.method).requireCompany(companyId);
        const body = createProjectSchema.parse(ctx.body ?? {});
        const project = await options.create(companyId, body, actor);
        const info = getHttpActorInfo(actor);
        await options.logActivity?.({
          companyId,
          actorType: info.actorType,
          actorId: info.actorId,
          agentId: info.agentId,
          action: "project.created",
          entityType: "project",
          entityId: project.id,
          details: { name: project.name },
        });
        options.trackProjectCreated?.();
        ctx.set.status = 201;
        return project;
      },
      { body: t.Any() },
    )
    .patch(
      "/api/projects/:id",
      async (ctx) => {
        const actor = await resolveActor(options, ctx);
        const existing = await getAccessibleHttpResource(
          actor,
          ctx.request.method,
          options.getById(ctx.params.id),
          "Project not found",
        );
        const body = updateProjectSchema.parse(ctx.body ?? {});
        const project = await options.update(existing.id, body, actor);
        if (!project) throw notFound("Project not found");
        const info = getHttpActorInfo(actor);
        await options.logActivity?.({
          companyId: project.companyId,
          actorType: info.actorType,
          actorId: info.actorId,
          agentId: info.agentId,
          action: "project.updated",
          entityType: "project",
          entityId: project.id,
          details: { changedKeys: Object.keys(body as object).sort() },
        });
        return project;
      },
      { body: t.Any() },
    )
    .get("/api/projects/:id/workspaces", async (ctx) => {
      const actor = await resolveActor(options, ctx);
      const existing = await getAccessibleHttpResource(
        actor,
        ctx.request.method,
        options.getById(ctx.params.id),
        "Project not found",
      );
      return options.listWorkspaces(existing.id);
    })
    .post(
      "/api/projects/:id/workspaces",
      async (ctx) => {
        const actor = await resolveActor(options, ctx);
        const existing = await getAccessibleHttpResource(
          actor,
          ctx.request.method,
          options.getById(ctx.params.id),
          "Project not found",
        );
        const body = createProjectWorkspaceSchema.parse(ctx.body ?? {});
        const workspace = await options.createWorkspace(existing.id, body);
        if (!workspace) throw unprocessable("Invalid project workspace payload");
        const info = getHttpActorInfo(actor);
        await options.logActivity?.({
          companyId: existing.companyId,
          actorType: info.actorType,
          actorId: info.actorId,
          agentId: info.agentId,
          action: "project.workspace_created",
          entityType: "project",
          entityId: existing.id,
          details: { workspaceId: (workspace as { id?: string }).id },
        });
        ctx.set.status = 201;
        return workspace;
      },
      { body: t.Any() },
    )
    .patch(
      "/api/projects/:id/workspaces/:workspaceId",
      async (ctx) => {
        const actor = await resolveActor(options, ctx);
        const existing = await getAccessibleHttpResource(
          actor,
          ctx.request.method,
          options.getById(ctx.params.id),
          "Project not found",
        );
        const body = updateProjectWorkspaceSchema.parse(ctx.body ?? {});
        const listed = await options.listWorkspaces(existing.id);
        const exists = Array.isArray(listed)
          && listed.some((entry) => entry && typeof entry === "object" && (entry as { id?: string }).id === ctx.params.workspaceId);
        if (!exists) throw notFound("Project workspace not found");
        const workspace = await options.updateWorkspace(
          existing.id,
          ctx.params.workspaceId,
          body,
        );
        if (!workspace) throw unprocessable("Invalid project workspace payload");
        return workspace;
      },
      { body: t.Any() },
    )
    .delete("/api/projects/:id/workspaces/:workspaceId", async (ctx) => {
      const actor = await resolveActor(options, ctx);
      const existing = await getAccessibleHttpResource(
        actor,
        ctx.request.method,
        options.getById(ctx.params.id),
        "Project not found",
      );
      const workspace = await options.removeWorkspace(existing.id, ctx.params.workspaceId);
      if (!workspace) throw notFound("Project workspace not found");
      const info = getHttpActorInfo(actor);
      await options.logActivity?.({
        companyId: existing.companyId,
        actorType: info.actorType,
        actorId: info.actorId,
        agentId: info.agentId,
        action: "project.workspace_deleted",
        entityType: "project",
        entityId: existing.id,
        details: { workspaceId: (workspace as { id?: string }).id },
      });
      return workspace;
    })
    .delete("/api/projects/:id", async (ctx) => {
      const actor = await resolveActor(options, ctx);
      const existing = await getAccessibleHttpResource(
        actor,
        ctx.request.method,
        options.getById(ctx.params.id),
        "Project not found",
      );
      const project = await options.remove(existing.id);
      if (!project) throw notFound("Project not found");
      const info = getHttpActorInfo(actor);
      await options.logActivity?.({
        companyId: project.companyId,
        actorType: info.actorType,
        actorId: info.actorId,
        agentId: info.agentId,
        action: "project.deleted",
        entityType: "project",
        entityId: project.id,
      });
      return project;
    });
}
