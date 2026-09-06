import { unauthorized } from "../errors.js";
import type { HttpActor } from "./actor-context.js";

export type HttpActorInfo =
  | {
      actorType: "agent";
      actorId: string;
      agentId: string | null;
      runId: string | null;
      agentApiKeyId: string | null;
      actorSource: "agent_key" | "agent_jwt";
    }
  | {
      actorType: "user";
      actorId: string;
      sessionId: string | null;
      agentId: null;
      runId: string | null;
      agentApiKeyId: null;
      actorSource: "local_implicit" | "session" | "board_key" | "cloud_tenant";
    };

/** Mirror Express getActorInfo for the Web/Elysia actor. */
export function getHttpActorInfo(actor: HttpActor): HttpActorInfo {
  if (actor.type === "none") throw unauthorized();
  if (actor.type === "agent") {
    return {
      actorType: "agent",
      actorId: actor.agentId ?? "unknown-agent",
      agentId: actor.agentId ?? null,
      runId: actor.runId ?? null,
      agentApiKeyId: actor.keyId ?? null,
      actorSource: actor.source === "agent_jwt" ? "agent_jwt" : "agent_key",
    };
  }
  const actorSource =
    actor.source === "local_implicit" ||
    actor.source === "board_key" ||
    actor.source === "cloud_tenant"
      ? actor.source
      : "session";
  return {
    actorType: "user",
    actorId: actor.userId ?? "unknown-user",
    sessionId: actor.sessionId ?? null,
    agentId: null,
    runId: actor.runId ?? null,
    agentApiKeyId: null,
    actorSource,
  };
}

export function assertHttpAuthenticated(actor: HttpActor): void {
  if (actor.type === "none") throw unauthorized();
}
