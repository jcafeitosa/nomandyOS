import { describe, expect, it } from "bun:test";
import { forbidden } from "../errors.js";
import { createProtectedHttpApp } from "./app.js";
import type { AccessMemberRecord } from "./access-plugin.js";

const board = {
  type: "board" as const,
  source: "local_implicit" as const,
  userId: "u1",
  isInstanceAdmin: true,
};

const member: AccessMemberRecord = {
  id: "m1",
  companyId: "c1",
  membershipRole: "member",
  status: "active",
};

function accessOpts(overrides: Record<string, unknown> = {}) {
  return {
    assertPermission: async () => {},
    listMembers: async () => ({ members: [member], access: { canManage: true } }),
    listUserDirectory: async () => ({ users: [{ id: "u1", name: "Ada" }] }),
    getMemberById: async (_c: string, id: string) => (id === "m1" ? member : null),
    updateMember: async () => ({ ...member, membershipRole: "admin" }),
    updateMemberAndPermissions: async () => ({ ...member, membershipRole: "admin" }),
    archiveMember: async () => ({ ok: true, memberId: "m1" }),
    listInvites: async () => [{ id: "inv1" }],
    listJoinRequests: async () => [{ id: "jr1", status: "pending_approval" }],
    ...overrides,
  };
}

describe("Elysia access plugin", () => {
  it("lists members with company permission", async () => {
    const app = createProtectedHttpApp({
      deploymentMode: "local_trusted",
      deploymentExposure: "private",
      authReady: true,
      resolveActor: () => board,
      access: accessOpts(),
    });
    const response = await app.handle(new Request("http://localhost/api/companies/c1/members"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      members: [member],
      access: { canManage: true },
    });
  });

  it("lists user directory with requireCompany only", async () => {
    const app = createProtectedHttpApp({
      deploymentMode: "local_trusted",
      deploymentExposure: "private",
      authReady: true,
      resolveActor: () => board,
      access: accessOpts(),
    });
    const response = await app.handle(
      new Request("http://localhost/api/companies/c1/user-directory"),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ users: [{ id: "u1", name: "Ada" }] });
  });

  it("denies members when permission gate fails", async () => {
    const app = createProtectedHttpApp({
      deploymentMode: "authenticated",
      deploymentExposure: "private",
      authReady: true,
      resolveActor: () => ({
        type: "board" as const,
        source: "session" as const,
        userId: "u2",
        companyIds: ["c1"],
        memberships: [{ companyId: "c1", membershipRole: "member", status: "active" }],
      }),
      access: accessOpts({
        assertPermission: async () => {
          throw forbidden("Permission denied");
        },
      }),
    });
    const response = await app.handle(new Request("http://localhost/api/companies/c1/members"));
    expect(response.status).toBe(403);
  });

  it("enforces responsible-user intersection on member write", async () => {
    const app = createProtectedHttpApp({
      deploymentMode: "authenticated",
      deploymentExposure: "private",
      authReady: true,
      resolveActor: () => ({
        type: "agent" as const,
        source: "agent_key" as const,
        agentId: "a1",
        companyId: "c1",
        onBehalfOfUserId: "u-resp",
        onBehalfOfMemberships: [
          { companyId: "c1", membershipRole: "viewer", status: "active" },
        ],
      }),
      access: accessOpts(),
    });
    const response = await app.handle(
      new Request("http://localhost/api/companies/c1/members/m1", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "suspended" }),
      }),
    );
    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error).toContain("Responsible user");
    expect(body.details?.code).toBe("RESPONSIBLE_USER_UNAUTHORIZED");
  });

  it("blocks cross-company agent on user-directory", async () => {
    const app = createProtectedHttpApp({
      deploymentMode: "authenticated",
      deploymentExposure: "private",
      authReady: true,
      resolveActor: () => ({
        type: "agent" as const,
        source: "agent_key" as const,
        agentId: "a1",
        companyId: "other",
      }),
      access: accessOpts(),
    });
    const response = await app.handle(
      new Request("http://localhost/api/companies/c1/user-directory"),
    );
    expect(response.status).toBe(403);
  });

  it("updates member with 200", async () => {
    const app = createProtectedHttpApp({
      deploymentMode: "local_trusted",
      deploymentExposure: "private",
      authReady: true,
      resolveActor: () => board,
      access: accessOpts(),
    });
    const response = await app.handle(
      new Request("http://localhost/api/companies/c1/members/m1", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ membershipRole: "admin" }),
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ membershipRole: "admin" });
  });

  it("returns 404 for unknown member", async () => {
    const app = createProtectedHttpApp({
      deploymentMode: "local_trusted",
      deploymentExposure: "private",
      authReady: true,
      resolveActor: () => board,
      access: accessOpts(),
    });
    const response = await app.handle(
      new Request("http://localhost/api/companies/c1/members/missing", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "suspended" }),
      }),
    );
    expect(response.status).toBe(404);
  });

  it("lists invites and join-requests", async () => {
    const app = createProtectedHttpApp({
      deploymentMode: "local_trusted",
      deploymentExposure: "private",
      authReady: true,
      resolveActor: () => board,
      access: accessOpts(),
    });
    const invites = await app.handle(new Request("http://localhost/api/companies/c1/invites"));
    expect(invites.status).toBe(200);
    expect(await invites.json()).toEqual([{ id: "inv1" }]);
    const joins = await app.handle(
      new Request("http://localhost/api/companies/c1/join-requests"),
    );
    expect(joins.status).toBe(200);
    expect(await joins.json()).toEqual([{ id: "jr1", status: "pending_approval" }]);
  });

  it("fails closed without actor", async () => {
    const app = createProtectedHttpApp({
      deploymentMode: "authenticated",
      deploymentExposure: "private",
      authReady: true,
      resolveActor: () => null,
      access: accessOpts(),
    });
    const response = await app.handle(new Request("http://localhost/api/companies/c1/members"));
    expect(response.status).toBe(401);
  });
});
