import { Elysia, t } from "elysia";
import {
  builtInAgentEmptyMutationSchema,
  builtInAgentProvisionSchema,
  builtInAgentResetSchema,
} from "@paperclipai/shared";
import { forbidden, notFound, unauthorized } from "../errors.js";
import type { HttpActor } from "./actor-context.js";
import { createHttpAuthorization } from "./authorization.js";
import { getHttpActorInfo } from "./actor-info.js";
import type { ActorResolver } from "./context.js";

export type BuiltInAgentState = {
  agentId: string | null;
  status: string;
  definition: {
    defaultInstructions?: string;
    bundle?: {
      stockVersion: string;
      instructions: { entryFile: string; files: Record<string, unknown> };
      skill: {
        skillKey: string;
        displayName: string;
        slug: string;
        canonicalKey: string;
        files: Record<string, unknown>;
      };
      routine: {
        routineKey: string;
        title: string;
        status: string;
        triggers: Array<{ cronExpression: string; timezone: string }>;
      };
    };
  };
  agent?: {
    adapterConfig?: Record<string, unknown>;
    runtimeConfig?: Record<string, unknown>;
    [key: string]: unknown;
  } | null;
  approval?: { id: string; status: string } | null;
  [key: string]: unknown;
};

const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function formatScheduleLabel(trigger: { cronExpression: string; timezone: string } | undefined) {
  if (!trigger) return "Weekly schedule";
  const parts = trigger.cronExpression.trim().split(/\s+/);
  const [minute, hour, , , dayOfWeek] = parts;
  const weekdayIndex = dayOfWeek ? Number(dayOfWeek) : Number.NaN;
  if (
    parts.length === 5 &&
    /^\d+$/.test(minute ?? "") &&
    /^\d+$/.test(hour ?? "") &&
    Number.isInteger(weekdayIndex) &&
    weekdayIndex >= 0 &&
    weekdayIndex < WEEKDAY_LABELS.length
  ) {
    return `Weekly · ${WEEKDAY_LABELS[weekdayIndex]} ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")} ${trigger.timezone}`;
  }
  return `Weekly · ${trigger.timezone}`;
}

/** Same redaction contract as Express built-in-agents routes. */
export function redactBuiltInAgentListState(state: BuiltInAgentState): BuiltInAgentState {
  const definition = {
    ...state.definition,
    defaultInstructions: state.definition.defaultInstructions ? "[file-backed]" : "",
    bundle: state.definition.bundle
      ? {
          stockVersion: state.definition.bundle.stockVersion,
          instructions: {
            entryFile: state.definition.bundle.instructions.entryFile,
            files: Object.keys(state.definition.bundle.instructions.files),
          },
          skill: {
            skillKey: state.definition.bundle.skill.skillKey,
            displayName: state.definition.bundle.skill.displayName,
            slug: state.definition.bundle.skill.slug,
            canonicalKey: state.definition.bundle.skill.canonicalKey,
            files: Object.keys(state.definition.bundle.skill.files),
          },
          routine: {
            routineKey: state.definition.bundle.routine.routineKey,
            title: state.definition.bundle.routine.title,
            status: state.definition.bundle.routine.status,
            triggerCount: state.definition.bundle.routine.triggers.length,
            scheduleLabel: formatScheduleLabel(state.definition.bundle.routine.triggers[0]),
          },
        }
      : undefined,
  } as BuiltInAgentState["definition"];
  if (!state.agent) return { ...state, definition };
  return {
    ...state,
    definition,
    agent: {
      ...state.agent,
      adapterConfig: {},
      runtimeConfig: {},
    },
  };
}

export type BuiltInAgentsPluginOptions = {
  resolveActor: ActorResolver;
  isBuiltInAgentsEnabled: () => Promise<boolean>;
  list: (companyId: string) => Promise<BuiltInAgentState[]>;
  get: (companyId: string, key: string) => Promise<BuiltInAgentState>;
  ensure: (companyId: string, key: string) => Promise<BuiltInAgentState>;
  provision: (
    companyId: string,
    key: string,
    body: unknown,
    meta: { requestedByAgentId: string | null; requestedByUserId: string | null },
  ) => Promise<{ state: BuiltInAgentState; approval: { id: string; status: string } | null }>;
  reset: (companyId: string, key: string, body: unknown) => Promise<BuiltInAgentState>;
  enableRoutineSchedule: (
    companyId: string,
    key: string,
    routineKey: string,
    actor: { agentId: string | null; userId: string | null; runId: string | null },
  ) => Promise<BuiltInAgentState>;
  disableRoutineSchedule: (
    companyId: string,
    key: string,
    routineKey: string,
    actor: { agentId: string | null; userId: string | null; runId: string | null },
  ) => Promise<BuiltInAgentState>;
  runRoutine: (
    companyId: string,
    key: string,
    routineKey: string,
    actor: { agentId: string | null; userId: string | null; runId: string | null },
  ) => Promise<{ id: string }>;
  decideAgentsCreate: (input: {
    actor: HttpActor;
    companyId: string;
  }) => Promise<{ allowed: boolean; explanation?: string; details?: Record<string, unknown> }>;
  canUserAssignTasks: (companyId: string, userId: string | undefined) => Promise<boolean>;
  logMutation?: (input: Record<string, unknown>) => Promise<void>;
};

async function resolveActor(
  options: BuiltInAgentsPluginOptions,
  ctx: { request: Request; actor?: HttpActor },
): Promise<HttpActor> {
  const actor = ctx.actor ?? (await options.resolveActor(ctx.request));
  if (!actor) throw unauthorized();
  return actor;
}

async function assertBuiltInAgentsEnabled(options: BuiltInAgentsPluginOptions) {
  if ((await options.isBuiltInAgentsEnabled()) !== true) {
    throw notFound("Built-in agents are not enabled");
  }
}

async function assertCanProvision(
  options: BuiltInAgentsPluginOptions,
  actor: HttpActor,
  method: string,
  companyId: string,
) {
  createHttpAuthorization(actor, method).requireCompany(companyId);
  const decision = await options.decideAgentsCreate({ actor, companyId });
  if (decision.allowed) return;
  throw forbidden(decision.explanation ?? "Forbidden", decision.details);
}

async function assertCanControlRoutine(
  options: BuiltInAgentsPluginOptions,
  actor: HttpActor,
  method: string,
  companyId: string,
) {
  createHttpAuthorization(actor, method).requireCompany(companyId);
  if (actor.type !== "board") {
    throw forbidden("Only board operators can control built-in routines.");
  }
  if (actor.source === "local_implicit" || actor.isInstanceAdmin) return;
  const allowed = await options.canUserAssignTasks(companyId, actor.userId);
  if (!allowed) throw forbidden("Missing permission: tasks:assign");
}

function mutationActor(actor: HttpActor) {
  const info = getHttpActorInfo(actor);
  return {
    agentId: info.actorType === "agent" ? info.actorId : null,
    userId: info.actorType === "user" ? info.actorId : null,
    runId: info.runId ?? null,
  };
}

export function createBuiltInAgentsPlugin(options: BuiltInAgentsPluginOptions) {
  return new Elysia({ name: "paperclip-built-in-agents" })
    .get("/api/companies/:companyId/built-in-agents", async (ctx) => {
      const actor = await resolveActor(options, ctx);
      createHttpAuthorization(actor, ctx.request.method).requireCompany(ctx.params.companyId);
      await assertBuiltInAgentsEnabled(options);
      const states = await options.list(ctx.params.companyId);
      return states.map(redactBuiltInAgentListState);
    })
    .get("/api/companies/:companyId/built-in-agents/:key/status", async (ctx) => {
      const actor = await resolveActor(options, ctx);
      createHttpAuthorization(actor, ctx.request.method).requireCompany(ctx.params.companyId);
      await assertBuiltInAgentsEnabled(options);
      return redactBuiltInAgentListState(await options.get(ctx.params.companyId, ctx.params.key));
    })
    .post(
      "/api/companies/:companyId/built-in-agents/:key/reconcile",
      async (ctx) => {
        const actor = await resolveActor(options, ctx);
        builtInAgentEmptyMutationSchema.parse(ctx.body ?? {});
        await assertBuiltInAgentsEnabled(options);
        await assertCanProvision(options, actor, ctx.request.method, ctx.params.companyId);
        const state = await options.ensure(ctx.params.companyId, ctx.params.key);
        await options.logMutation?.({
          companyId: ctx.params.companyId,
          action: "built_in_agent.reconcile",
          key: ctx.params.key,
          agentId: state.agentId,
          status: state.status,
          actor: getHttpActorInfo(actor),
        });
        return redactBuiltInAgentListState(state);
      },
      { body: t.Any() },
    )
    .post(
      "/api/companies/:companyId/built-in-agents/:key/provision",
      async (ctx) => {
        const actor = await resolveActor(options, ctx);
        const body = builtInAgentProvisionSchema.parse(ctx.body ?? {});
        await assertBuiltInAgentsEnabled(options);
        await assertCanProvision(options, actor, ctx.request.method, ctx.params.companyId);
        const info = getHttpActorInfo(actor);
        const { state, approval } = await options.provision(ctx.params.companyId, ctx.params.key, body, {
          requestedByAgentId: info.actorType === "agent" ? info.actorId : null,
          requestedByUserId: info.actorType === "user" ? info.actorId : null,
        });
        await options.logMutation?.({
          companyId: ctx.params.companyId,
          action: "built_in_agent.provision_requested",
          key: ctx.params.key,
          agentId: state.agentId,
          status: state.status,
          actor: info,
        });
        ctx.set.status = approval ? 202 : 200;
        return redactBuiltInAgentListState({ ...state, approval });
      },
      { body: t.Any() },
    )
    .post(
      "/api/companies/:companyId/built-in-agents/:key/reset",
      async (ctx) => {
        const actor = await resolveActor(options, ctx);
        const body = builtInAgentResetSchema.parse(ctx.body ?? {});
        await assertBuiltInAgentsEnabled(options);
        await assertCanProvision(options, actor, ctx.request.method, ctx.params.companyId);
        const state = await options.reset(ctx.params.companyId, ctx.params.key, body);
        await options.logMutation?.({
          companyId: ctx.params.companyId,
          action: "built_in_agent.reset",
          key: ctx.params.key,
          agentId: state.agentId,
          status: state.status,
          actor: getHttpActorInfo(actor),
        });
        return redactBuiltInAgentListState(state);
      },
      { body: t.Any() },
    )
    .post(
      "/api/companies/:companyId/built-in-agents/:key/routines/:routineKey/enable",
      async (ctx) => {
        const actor = await resolveActor(options, ctx);
        builtInAgentEmptyMutationSchema.parse(ctx.body ?? {});
        await assertBuiltInAgentsEnabled(options);
        await assertCanControlRoutine(options, actor, ctx.request.method, ctx.params.companyId);
        const state = await options.enableRoutineSchedule(
          ctx.params.companyId,
          ctx.params.key,
          ctx.params.routineKey,
          mutationActor(actor),
        );
        return redactBuiltInAgentListState(state);
      },
      { body: t.Any() },
    )
    .post(
      "/api/companies/:companyId/built-in-agents/:key/routines/:routineKey/disable",
      async (ctx) => {
        const actor = await resolveActor(options, ctx);
        builtInAgentEmptyMutationSchema.parse(ctx.body ?? {});
        await assertBuiltInAgentsEnabled(options);
        await assertCanControlRoutine(options, actor, ctx.request.method, ctx.params.companyId);
        const state = await options.disableRoutineSchedule(
          ctx.params.companyId,
          ctx.params.key,
          ctx.params.routineKey,
          mutationActor(actor),
        );
        return redactBuiltInAgentListState(state);
      },
      { body: t.Any() },
    )
    .post(
      "/api/companies/:companyId/built-in-agents/:key/routines/:routineKey/run",
      async (ctx) => {
        const actor = await resolveActor(options, ctx);
        builtInAgentEmptyMutationSchema.parse(ctx.body ?? {});
        await assertBuiltInAgentsEnabled(options);
        createHttpAuthorization(actor, ctx.request.method).requireCompany(ctx.params.companyId);
        await assertCanControlRoutine(options, actor, ctx.request.method, ctx.params.companyId);
        const run = await options.runRoutine(
          ctx.params.companyId,
          ctx.params.key,
          ctx.params.routineKey,
          mutationActor(actor),
        );
        ctx.set.status = 202;
        return run;
      },
      { body: t.Any() },
    );
}
