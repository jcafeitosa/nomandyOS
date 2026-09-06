import { notFound } from "../errors.js";
import type { HttpActor } from "./actor-context.js";
import { createHttpAuthorization } from "./authorization.js";

/**
 * Existence-oracle-safe company membership check (read path).
 * Mirrors Express `hasCompanyAccess`: instance admins do NOT get blanket access.
 */
export function hasHttpCompanyAccess(actor: HttpActor, companyId: string): boolean {
  if (actor.type === "none") return false;
  if (actor.type === "agent") return actor.companyId === companyId;
  if (actor.source === "local_implicit") return true;
  return (actor.companyIds ?? []).includes(companyId);
}

/**
 * Fetch a company-scoped resource by id without leaking cross-tenant existence.
 * Missing or cross-tenant → identical 404; accessible → requireCompany (write checks).
 */
export async function getAccessibleHttpResource<T extends { companyId: string }>(
  actor: HttpActor,
  method: string,
  resource: T | null | undefined | Promise<T | null | undefined>,
  notFoundMessage: string,
): Promise<T> {
  const resolved = await resource;
  if (!resolved || !hasHttpCompanyAccess(actor, resolved.companyId)) {
    throw notFound(notFoundMessage);
  }
  createHttpAuthorization(actor, method).requireCompany(resolved.companyId);
  return resolved;
}
