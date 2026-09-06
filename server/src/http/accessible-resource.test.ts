import { describe, expect, it } from "bun:test";
import { getAccessibleHttpResource, hasHttpCompanyAccess } from "./accessible-resource.js";

describe("accessible HTTP resource helper", () => {
  it("grants local_implicit board access", () => {
    expect(
      hasHttpCompanyAccess(
        { type: "board", source: "local_implicit", userId: "u1" },
        "c1",
      ),
    ).toBe(true);
  });

  it("denies session board without company membership", () => {
    expect(
      hasHttpCompanyAccess(
        { type: "board", source: "session", userId: "u1", companyIds: ["other"], isInstanceAdmin: true },
        "c1",
      ),
    ).toBe(false);
  });

  it("returns identical 404 for missing and cross-tenant", async () => {
    const actor = {
      type: "board" as const,
      source: "session" as const,
      userId: "u1",
      companyIds: ["other"],
    };
    await expect(
      getAccessibleHttpResource(actor, "GET", null, "Goal not found"),
    ).rejects.toMatchObject({ status: 404, message: "Goal not found" });
    await expect(
      getAccessibleHttpResource(
        actor,
        "GET",
        { id: "g1", companyId: "c1" },
        "Goal not found",
      ),
    ).rejects.toMatchObject({ status: 404, message: "Goal not found" });
  });
});
