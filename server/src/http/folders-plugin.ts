import { Elysia, t } from "elysia";
import {
  createFolderSchema,
  ensureMySkillFolderSchema,
  folderKindSchema,
  moveFolderItemSchema,
  moveFolderSchema,
  updateFolderSchema,
} from "@paperclipai/shared";
import { badRequest, forbidden, notFound, unauthorized } from "../errors.js";
import type { HttpActor } from "./actor-context.js";
import { createHttpAuthorization } from "./authorization.js";
import { getHttpActorInfo } from "./actor-info.js";
import type { ActorResolver } from "./context.js";

export type FolderRecord = {
  id: string;
  companyId?: string;
  kind: string;
  name: string;
  path: string;
  parentId?: string | null;
  position?: number;
  systemKey?: string | null;
  [key: string]: unknown;
};

export type FoldersPluginOptions = {
  resolveActor: ActorResolver;
  list: (companyId: string, kind: string) => Promise<unknown>;
  create: (companyId: string, body: unknown) => Promise<FolderRecord>;
  ensureMyFolder: (
    companyId: string,
    userId: string,
    userName: string | null,
    slug: unknown,
  ) => Promise<FolderRecord>;
  update: (companyId: string, folderId: string, body: unknown) => Promise<FolderRecord | null>;
  moveItem: (companyId: string, body: unknown) => Promise<{ itemId: string; kind: string; folderId: string | null }>;
  moveFolder: (companyId: string, folderId: string, body: unknown) => Promise<FolderRecord | null>;
  deleteFolder: (companyId: string, folderId: string) => Promise<FolderRecord | null>;
  logActivity?: (input: Record<string, unknown>) => Promise<void>;
};

function firstQuery(url: URL, key: string): string | undefined {
  const value = url.searchParams.get(key);
  return value === null ? undefined : value;
}

function parseKind(value: unknown) {
  const result = folderKindSchema.safeParse(value);
  if (!result.success) throw badRequest("Folder kind query parameter is required");
  return result.data;
}

async function resolveActor(
  options: FoldersPluginOptions,
  ctx: { request: Request; actor?: HttpActor },
): Promise<HttpActor> {
  const actor = ctx.actor ?? (await options.resolveActor(ctx.request));
  if (!actor) throw unauthorized();
  return actor;
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

export function createFoldersPlugin(options: FoldersPluginOptions) {
  return new Elysia({ name: "paperclip-folders" })
    .get("/api/companies/:companyId/folders", async (ctx) => {
      const actor = await resolveActor(options, ctx);
      const companyId = ctx.params.companyId;
      createHttpAuthorization(actor, ctx.request.method).requireCompany(companyId);
      const url = new URL(ctx.request.url);
      return options.list(companyId, parseKind(firstQuery(url, "kind")));
    })
    .post(
      "/api/companies/:companyId/folders",
      async (ctx) => {
        const actor = await resolveActor(options, ctx);
        const companyId = ctx.params.companyId;
        createHttpAuthorization(actor, ctx.request.method).requireCompany(companyId);
        const body = createFolderSchema.parse(ctx.body ?? {});
        const created = await options.create(companyId, body);
        await options.logActivity?.({
          companyId,
          ...activityActor(actor),
          action: "folder.created",
          entityType: "folder",
          entityId: created.id,
          details: {
            kind: created.kind,
            name: created.name,
            path: created.path,
            parentId: created.parentId,
            position: created.position,
          },
        });
        ctx.set.status = 201;
        return created;
      },
      { body: t.Any() },
    )
    .post(
      "/api/companies/:companyId/folders/ensure-my",
      async (ctx) => {
        const actor = await resolveActor(options, ctx);
        const companyId = ctx.params.companyId;
        createHttpAuthorization(actor, ctx.request.method).requireCompany(companyId);
        if (actor.type !== "board" || !actor.userId) {
          throw forbidden("A signed-in board user is required to create a personal skill folder");
        }
        const body = ensureMySkillFolderSchema.parse(ctx.body ?? {});
        const folder = await options.ensureMyFolder(
          companyId,
          actor.userId,
          actor.userName ?? null,
          body.slug,
        );
        await options.logActivity?.({
          companyId,
          ...activityActor(actor),
          action: "folder.personal_ensured",
          entityType: "folder",
          entityId: folder.id,
          details: { path: folder.path, systemKey: folder.systemKey },
        });
        return folder;
      },
      { body: t.Any() },
    )
    .patch(
      "/api/companies/:companyId/folders/:folderId",
      async (ctx) => {
        const actor = await resolveActor(options, ctx);
        const companyId = ctx.params.companyId;
        createHttpAuthorization(actor, ctx.request.method).requireCompany(companyId);
        const body = updateFolderSchema.parse(ctx.body ?? {});
        const updated = await options.update(companyId, ctx.params.folderId, body);
        if (!updated) throw notFound("Folder not found");
        await options.logActivity?.({
          companyId,
          ...activityActor(actor),
          action: "folder.updated",
          entityType: "folder",
          entityId: updated.id,
          details: {
            kind: updated.kind,
            name: updated.name,
            path: updated.path,
            position: updated.position,
          },
        });
        return updated;
      },
      { body: t.Any() },
    )
    .post(
      "/api/companies/:companyId/folders/items/move",
      async (ctx) => {
        const actor = await resolveActor(options, ctx);
        const companyId = ctx.params.companyId;
        createHttpAuthorization(actor, ctx.request.method).requireCompany(companyId);
        const body = moveFolderItemSchema.parse(ctx.body ?? {});
        const moved = await options.moveItem(companyId, body);
        await options.logActivity?.({
          companyId,
          ...activityActor(actor),
          action: "folder.item_moved",
          entityType: body.kind === "routine" ? "routine" : "company_skill",
          entityId: moved.itemId,
          details: { kind: moved.kind, folderId: moved.folderId },
        });
        return moved;
      },
      { body: t.Any() },
    )
    .post(
      "/api/companies/:companyId/folders/:folderId/move",
      async (ctx) => {
        const actor = await resolveActor(options, ctx);
        const companyId = ctx.params.companyId;
        createHttpAuthorization(actor, ctx.request.method).requireCompany(companyId);
        const body = moveFolderSchema.parse(ctx.body ?? {});
        const updated = await options.moveFolder(companyId, ctx.params.folderId, body);
        if (!updated) throw notFound("Folder not found");
        await options.logActivity?.({
          companyId,
          ...activityActor(actor),
          action: "folder.moved",
          entityType: "folder",
          entityId: updated.id,
          details: {
            kind: updated.kind,
            parentId: updated.parentId,
            path: updated.path,
            position: updated.position,
          },
        });
        return updated;
      },
      { body: t.Any() },
    )
    .delete("/api/companies/:companyId/folders/:folderId", async (ctx) => {
      const actor = await resolveActor(options, ctx);
      const companyId = ctx.params.companyId;
      createHttpAuthorization(actor, ctx.request.method).requireCompany(companyId);
      const deleted = await options.deleteFolder(companyId, ctx.params.folderId);
      if (!deleted) throw notFound("Folder not found");
      await options.logActivity?.({
        companyId,
        ...activityActor(actor),
        action: "folder.deleted",
        entityType: "folder",
        entityId: deleted.id,
        details: { kind: deleted.kind, name: deleted.name },
      });
      return { deleted };
    });
}
