import { Elysia, t } from "elysia";
import {
  archiveCompanyMemberSchema,
  updateCompanyMemberSchema,
  updateCompanyMemberWithPermissionsSchema,
} from "@paperclipai/shared";
import { forbidden, notFound, unauthorized } from "../errors.js";
import type { HttpActor } from "./actor-context.js";
import { createHttpAuthorization } from "./authorization.js";
import { getHttpActorInfo } from "./actor-info.js";
import type { ActorResolver } from "./context.js";

export type AccessMemberRecord = {
  id: string;
  companyId?: string;
  membershipRole?: string | null;
  status?: string;
  [key: string]: unknown;
};

export type AccessPluginOptions = {
  resolveActor: ActorResolver;
  /**
   * Permission gate after requireCompany — mirrors Express assertCompanyPermission.
   * Throw forbidden/unauthorized to deny.
   */
  assertPermission: (
    actor: HttpActor,
    companyId: string,
    permissionKey: string,
  ) => Promise<void>;
  listMembers: (companyId: string) => Promise<{ members: unknown; access: unknown }>;
  listUserDirectory: (companyId: string) => Promise<{ users: unknown }>;
  getMemberById: (companyId: string, memberId: string) => Promise<AccessMemberRecord | null>;
  updateMember: (
    companyId: string,
    memberId: string,
    body: unknown,
    actor: HttpActor,
  ) => Promise<AccessMemberRecord | null>;
  updateMemberAndPermissions: (
    companyId: string,
    memberId: string,
    body: unknown,
    actor: HttpActor,
  ) => Promise<AccessMemberRecord | null>;
  archiveMember: (
    companyId: string,
    memberId: string,
    body: unknown,
    actor: HttpActor,
  ) => Promise<unknown>;
  listInvites: (companyId: string, query: Record<string, string | undefined>) => Promise<unknown>;
  listJoinRequests: (
    companyId: string,
    query: Record<string, string | undefined>,
  ) => Promise<unknown>;
  logActivity?: (input: Record<string, unknown>) => Promise<void>;
};

async function resolveActor(
  options: AccessPluginOptions,
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

async function requireCompanyPermission(
  options: AccessPluginOptions,
  actor: HttpActor,
  method: string,
  companyId: string,
  permissionKey: string,
) {
  createHttpAuthorization(actor, method).requireCompany(companyId);
  await options.assertPermission(actor, companyId, permissionKey);
}

export function createAccessPlugin(options: AccessPluginOptions) {
  return new Elysia({ name: "paperclip-access" })
    .get("/api/companies/:companyId/members", async (ctx) => {
      const actor = await resolveActor(options, ctx);
      const companyId = ctx.params.companyId;
      await requireCompanyPermission(
        options,
        actor,
        ctx.request.method,
        companyId,
        "users:manage_permissions",
      );
      return options.listMembers(companyId);
    })
    .get("/api/companies/:companyId/user-directory", async (ctx) => {
      const actor = await resolveActor(options, ctx);
      const companyId = ctx.params.companyId;
      createHttpAuthorization(actor, ctx.request.method).requireCompany(companyId);
      return options.listUserDirectory(companyId);
    })
    .patch(
      "/api/companies/:companyId/members/:memberId",
      async (ctx) => {
        const actor = await resolveActor(options, ctx);
        const companyId = ctx.params.companyId;
        const memberId = ctx.params.memberId;
        await requireCompanyPermission(
          options,
          actor,
          ctx.request.method,
          companyId,
          "users:manage_permissions",
        );
        const existing = await options.getMemberById(companyId, memberId);
        if (!existing) throw notFound("Member not found");
        const body = updateCompanyMemberSchema.parse(ctx.body ?? {});
        const updated = await options.updateMember(companyId, memberId, body, actor);
        if (!updated) throw notFound("Member not found");
        const info = getHttpActorInfo(actor);
        await options.logActivity?.({
          companyId,
          actorType: info.actorType,
          actorId: info.actorId,
          action: "company_member.updated",
          entityType: "company_membership",
          entityId: memberId,
          details: {
            membershipRole: updated.membershipRole,
            status: updated.status,
          },
        });
        return updated;
      },
      { body: t.Any() },
    )
    .patch(
      "/api/companies/:companyId/members/:memberId/role-and-grants",
      async (ctx) => {
        const actor = await resolveActor(options, ctx);
        const companyId = ctx.params.companyId;
        const memberId = ctx.params.memberId;
        await requireCompanyPermission(
          options,
          actor,
          ctx.request.method,
          companyId,
          "users:manage_permissions",
        );
        const existing = await options.getMemberById(companyId, memberId);
        if (!existing) throw notFound("Member not found");
        const body = updateCompanyMemberWithPermissionsSchema.parse(ctx.body ?? {});
        const updated = await options.updateMemberAndPermissions(
          companyId,
          memberId,
          body,
          actor,
        );
        if (!updated) throw notFound("Member not found");
        const info = getHttpActorInfo(actor);
        await options.logActivity?.({
          companyId,
          actorType: info.actorType,
          actorId: info.actorId,
          action: "company_member.access_updated",
          entityType: "company_membership",
          entityId: memberId,
          details: {
            membershipRole: updated.membershipRole,
            status: updated.status,
            grantCount: body.grants?.length ?? 0,
          },
        });
        return updated;
      },
      { body: t.Any() },
    )
    .post(
      "/api/companies/:companyId/members/:memberId/archive",
      async (ctx) => {
        const actor = await resolveActor(options, ctx);
        const companyId = ctx.params.companyId;
        const memberId = ctx.params.memberId;
        await requireCompanyPermission(
          options,
          actor,
          ctx.request.method,
          companyId,
          "users:manage_permissions",
        );
        const existing = await options.getMemberById(companyId, memberId);
        if (!existing) throw notFound("Member not found");
        const body = archiveCompanyMemberSchema.parse(ctx.body ?? {});
        return options.archiveMember(companyId, memberId, body, actor);
      },
      { body: t.Any() },
    )
    .get("/api/companies/:companyId/invites", async (ctx) => {
      const actor = await resolveActor(options, ctx);
      const companyId = ctx.params.companyId;
      await requireCompanyPermission(
        options,
        actor,
        ctx.request.method,
        companyId,
        "users:invite",
      );
      const url = new URL(ctx.request.url);
      return options.listInvites(companyId, {
        status: firstQuery(url, "status"),
      });
    })
    .get("/api/companies/:companyId/join-requests", async (ctx) => {
      const actor = await resolveActor(options, ctx);
      const companyId = ctx.params.companyId;
      await requireCompanyPermission(
        options,
        actor,
        ctx.request.method,
        companyId,
        "joins:approve",
      );
      const url = new URL(ctx.request.url);
      return options.listJoinRequests(companyId, {
        status: firstQuery(url, "status"),
        requestType: firstQuery(url, "requestType"),
      });
    });
}
