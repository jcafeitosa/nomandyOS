/**
 * @fileoverview Adapter management REST API (Elysia parity plugin).
 *
 * NOM-48 — route-group parity slice 6. Port of `routes/adapters.ts` (Express)
 * onto the Elysia HTTP boundary, following the house style of `agents-plugin.ts`.
 * The Express `routes/adapters.ts` remains the production oracle until cutover.
 * Response contracts, status codes, auth floors, and side-effects mirror the
 * oracle exactly so the Elysia route group is a drop-in equivalent.
 *
 * Auth mapping (HttpActor -> Express authz.ts):
 * - assertBoardOrgAccess -> board actor + (local_implicit | isInstanceAdmin | companyIds)
 * - assertInstanceAdmin   -> board actor + (local_implicit | isInstanceAdmin)
 * - assertAdapterCodeInstallAllowed -> isCloudManagedInstance() floor
 * - assertAdapterManagementVisible -> getHiddenSettings().has("instance.adapters")
 */
import { Elysia } from "elysia";
import { execFile } from "node:child_process";
import fs from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { badRequest, forbidden, HttpError, notFound, unauthorized } from "../errors.js";
import type { HttpActor } from "./actor-context.js";
import type { ActorResolver } from "./context.js";
import {
  listServerAdapters,
  findServerAdapter,
  findActiveServerAdapter,
  registerServerAdapter,
  resolveExternalAdapterRegistration,
  unregisterServerAdapter,
  isOverridePaused,
  setOverridePaused,
} from "../adapters/registry.js";
import {
  listAdapterPlugins,
  addAdapterPlugin,
  removeAdapterPlugin,
  getAdapterPluginByType,
  getAdapterPluginsDir,
  getDisabledAdapterTypes,
  setAdapterDisabled,
} from "../services/adapter-plugin-store.js";
import type { AdapterPluginRecord } from "../services/adapter-plugin-store.js";
import type { ServerAdapterModule, AdapterConfigSchema } from "../adapters/types.js";
import type {
  AdapterLoginPanelMode,
  AdapterLoginTimeoutPolicy,
} from "@paperclipai/adapter-utils";
import {
  loadExternalAdapterPackage,
  getOrExtractUiParserSource,
  reloadExternalAdapter,
} from "../adapters/plugin-loader.js";
import { logger } from "../middleware/logger.js";
import { isCloudManagedInstance } from "../services/cloud-instance.js";
import { getHiddenSettings } from "../services/settings-visibility.js";
import { BUILTIN_ADAPTER_TYPES } from "../adapters/builtin-adapter-types.js";

const execFileAsync = promisify(execFile);
// ---------------------------------------------------------------------------
// Request / Response types (mirror the oracle)
// ---------------------------------------------------------------------------

interface AdapterInstallRequest {
  packageName: string;
  isLocalPath?: boolean;
  version?: string;
}

interface AdapterLoginProjection {
  panelMode: AdapterLoginPanelMode;
  timeoutPolicy: AdapterLoginTimeoutPolicy;
}

interface AdapterCapabilities {
  supportsInstructionsBundle: boolean;
  supportsSkills: boolean;
  supportsLocalAgentJwt: boolean;
  requiresMaterializedRuntimeSkills: boolean;
  supportsAcp: boolean;
  login?: AdapterLoginProjection;
}

interface AdapterInfo {
  type: string;
  label: string;
  source: "builtin" | "external";
  modelsCount: number;
  loaded: boolean;
  disabled: boolean;
  capabilities: AdapterCapabilities;
  acp?: ServerAdapterModule["acp"];
  overriddenBuiltin?: boolean;
  overridePaused?: boolean;
  version?: string;
  packageName?: string;
  isLocalPath?: boolean;
}

// ---------------------------------------------------------------------------
// Guards (HttpActor equivalents of server/routes/authz.ts)
// ---------------------------------------------------------------------------

export interface AdaptersPluginOptions {
  resolveActor: ActorResolver;
  /** Mirrors routes/adapters.ts `getNativeRunnerEnabled` option. */
  getNativeRunnerEnabled?: () => Promise<boolean>;
}

async function resolveActor(
  options: AdaptersPluginOptions,
  ctx: { request: Request; actor?: HttpActor },
): Promise<HttpActor> {
  const actor = ctx.actor ?? (await options.resolveActor(ctx.request));
  if (!actor) throw unauthorized();
  return actor;
}

function isBoard(actor: HttpActor): boolean {
  return actor.type === "board";
}

/** Mirrors assertBoardOrgAccess: board + (implicit | admin | has company). */
function assertBoardOrgAccess(actor: HttpActor): void {
  if (!isBoard(actor)) throw forbidden("Board access required");
  if (actor.source === "local_implicit" || actor.isInstanceAdmin) return;
  if (Array.isArray(actor.companyIds) && actor.companyIds.length > 0) return;
  throw forbidden("Company membership or instance admin access required");
}

/** Mirrors assertInstanceAdmin: board + (implicit | admin). */
function assertInstanceAdmin(actor: HttpActor): void {
  if (!isBoard(actor)) throw forbidden("Board access required");
  if (actor.source === "local_implicit" || actor.isInstanceAdmin) return;
  throw forbidden("Instance admin access required");
}

/**
 * Floor: on cloud-managed instances adapter code is bundled into the platform
 * image; runtime fetch/load stays off for every actor. Mirrors the oracle.
 */
function assertAdapterCodeInstallAllowed(): void {
  if (isCloudManagedInstance()) {
    throw forbidden("Adapter installation is platform-managed on cloud-managed instances", {
      code: "adapter_install_platform_managed",
    });
  }
}

/** Floor: when the hosting operator hides Adapters settings, writes are rejected. */
function assertAdapterManagementVisible(): void {
  if (getHiddenSettings().has("instance.adapters")) {
    throw forbidden("Adapter management is managed by the hosting operator on this instance", {
      code: "settings_operator_managed",
    });
  }
}
// ---------------------------------------------------------------------------
// Helpers (mirror the oracle, no project-injected services: the plugin reads
// the same registry/store/loader modules the Express routes use)
// ---------------------------------------------------------------------------

function resolveAdapterPackageDir(record: AdapterPluginRecord): string {
  return record.localPath
    ? path.resolve(record.localPath)
    : path.resolve(getAdapterPluginsDir(), "node_modules", record.packageName);
}

function readAdapterPackageVersionFromDisk(record: AdapterPluginRecord): string | undefined {
  try {
    const pkgDir = resolveAdapterPackageDir(record);
    const raw = fs.readFileSync(path.join(pkgDir, "package.json"), "utf-8");
    const v = JSON.parse(raw).version;
    return typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Build the client capability view for one adapter. The login projection carries
 * only the safe scalar fields; it drops function members and the completion
 * claim, so the response holds no secret and no code.
 */
export function buildAdapterCapabilities(adapter: ServerAdapterModule): AdapterCapabilities {
  const login = adapter.loginCapability;
  return {
    supportsInstructionsBundle: adapter.supportsInstructionsBundle ?? false,
    supportsSkills: Boolean(adapter.listSkills || adapter.syncSkills),
    supportsLocalAgentJwt: adapter.supportsLocalAgentJwt ?? false,
    requiresMaterializedRuntimeSkills: adapter.requiresMaterializedRuntimeSkills ?? false,
    supportsAcp: Boolean(adapter.acp),
    ...(login
      ? {
          login: {
            panelMode: login.panelMode,
            timeoutPolicy: login.timeoutPolicy,
          },
        }
      : {}),
  };
}

function buildAdapterInfo(
  adapter: ServerAdapterModule,
  externalRecord: AdapterPluginRecord | undefined,
  disabledSet: Set<string>,
): AdapterInfo {
  const fromDisk = externalRecord ? readAdapterPackageVersionFromDisk(externalRecord) : undefined;
  return {
    type: adapter.type,
    label: adapter.type,
    source: externalRecord ? "external" : "builtin",
    modelsCount: (adapter.models ?? []).length,
    loaded: true,
    disabled: disabledSet.has(adapter.type),
    capabilities: buildAdapterCapabilities(adapter),
    ...(adapter.acp ? { acp: adapter.acp } : {}),
    overriddenBuiltin: externalRecord ? BUILTIN_ADAPTER_TYPES.has(adapter.type) : undefined,
    overridePaused: BUILTIN_ADAPTER_TYPES.has(adapter.type) ? isOverridePaused(adapter.type) : undefined,
    version: fromDisk ?? externalRecord?.version,
    packageName: externalRecord?.packageName,
    isLocalPath: externalRecord?.localPath ? true : undefined,
  };
}

/**
 * Normalize a local path that may be a Windows path into a WSL-compatible path.
 * Windows paths are converted via `wslpath -u`; / already POSIX stays as-is.
 */
async function normalizeLocalPath(rawPath: string): Promise<string> {
  if (rawPath.startsWith("/")) return rawPath;
  if (/^[A-Za-z]:[\\/]/.test(rawPath)) {
    try {
      const { stdout } = await execFileAsync("wslpath", ["-u", rawPath]);
      return stdout.trim();
    } catch (err) {
      logger.warn({ err, rawPath }, "wslpath conversion failed; using path as-is");
      return rawPath;
    }
  }
  return rawPath;
}

/** Register an external adapter module into the registry via the hot-install path. */
function registerWithSessionManagement(adapter: ServerAdapterModule): void {
  registerServerAdapter(resolveExternalAdapterRegistration(adapter));
}
// ---------------------------------------------------------------------------
// Config-schema cache (mirrors the oracle's module-scoped cache)
// ---------------------------------------------------------------------------
const CONFIG_SCHEMA_TTL_MS = 30_000;
const configSchemaCache = new Map<
  string,
  { adapter: ServerAdapterModule; schema: AdapterConfigSchema; fetchedAt: number }
>();

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

/**
 * Adapter management REST API on the Elysia HTTP boundary.
 *
 * Mirrors `routes/adapters.ts` route-for-route: same paths, status codes, and
 * response bodies. Read routes require board-org access; mutating routes that
 * install/reload/toggle adapter code require instance-admin. Oracle (Express)
 * stays untouched until migration cutover, so this plugin runs as a parity
 * equivalent behind the same auth floors.
 */
export function createAdaptersPlugin(options: AdaptersPluginOptions) {
  const app = new Elysia({ name: "paperclip-adapters" });

  // GET /api/adapters — list all registered adapters (built-in + external)
  app.get("/api/adapters", async ({ request, actor }) => {
    const authActor = await resolveActor(options, { request, actor });
    assertBoardOrgAccess(authActor);

    const registeredAdapters = listServerAdapters();
    const externalRecords = new Map(listAdapterPlugins().map((r) => [r.type, r]));
    const disabledSet = new Set(getDisabledAdapterTypes());
    const nativeRunnerEnabled = (await options.getNativeRunnerEnabled?.().catch(() => false)) ?? false;
    if (!nativeRunnerEnabled) disabledSet.add("paperclip_runner");

    return registeredAdapters
      .map((adapter) => buildAdapterInfo(adapter, externalRecords.get(adapter.type), disabledSet))
      .sort((a, b) => a.type.localeCompare(b.type));
  });

  // POST /api/adapters/install — install an external adapter (npm or local path)
  app.post("/api/adapters/install", async ({ request, actor, body }) => {
    const authActor = await resolveActor(options, { request, actor });
    assertInstanceAdmin(authActor);
    assertAdapterCodeInstallAllowed();
    assertAdapterManagementVisible();

    const { packageName, isLocalPath = false, version } = (body ?? {}) as AdapterInstallRequest;
    if (!packageName || typeof packageName !== "string") {
      throw badRequest("packageName is required and must be a string.");
    }

    let canonicalName = packageName;
    let explicitVersion = version;
    const versionSuffix = packageName.match(/@(\d+\.\d+\.\d+.*)$/);
    if (versionSuffix) {
      const lastAtIndex = packageName.lastIndexOf("@");
      if (lastAtIndex > 0 && !explicitVersion) {
        canonicalName = packageName.slice(0, lastAtIndex);
        explicitVersion = versionSuffix[1];
      }
    }

    try {
      let installedVersion: string | undefined;
      let moduleLocalPath: string | undefined;

      if (!isLocalPath) {
        const pluginsDir = getAdapterPluginsDir();
        const spec = explicitVersion ? `${canonicalName}@${explicitVersion}` : canonicalName;
        logger.info({ spec, pluginsDir }, "Installing adapter package via npm");
        await execFileAsync("npm", ["install", "--no-save", spec], {
          cwd: pluginsDir,
          timeout: 120_000,
        });
        try {
          const pkgJsonPath = path.join(pluginsDir, "node_modules", canonicalName, "package.json");
          const pkgRaw = await readFile(pkgJsonPath, "utf-8");
          const v = JSON.parse(pkgRaw).version;
          installedVersion = typeof v === "string" && v.trim().length > 0 ? v.trim() : explicitVersion;
        } catch {
          installedVersion = explicitVersion;
        }
      } else {
        moduleLocalPath = path.resolve(await normalizeLocalPath(packageName));
        try {
          const pkgRaw = await readFile(path.join(moduleLocalPath, "package.json"), "utf-8");
          const v = JSON.parse(pkgRaw).version;
          if (typeof v === "string" && v.trim().length > 0) installedVersion = v.trim();
        } catch {
          // leave undefined if package.json missing
        }
      }

      const adapterModule = await loadExternalAdapterPackage(canonicalName, moduleLocalPath);
      const existing = findServerAdapter(adapterModule.type);
      const isReinstall = existing !== null && !!getAdapterPluginByType(adapterModule.type);
      if (existing) {
        unregisterServerAdapter(adapterModule.type);
        logger.info({ type: adapterModule.type }, "Unregistered existing adapter for replacement");
      }

      registerWithSessionManagement(adapterModule);

      const record: AdapterPluginRecord = {
        packageName: canonicalName,
        localPath: moduleLocalPath,
        version: installedVersion ?? explicitVersion,
        type: adapterModule.type,
        installedAt: new Date().toISOString(),
      };
      addAdapterPlugin(record);
      logger.info({ type: adapterModule.type, packageName: canonicalName }, "External adapter installed and registered");

      return new Response(
        JSON.stringify({
          type: adapterModule.type,
          packageName: canonicalName,
          version: installedVersion ?? explicitVersion,
          installedAt: record.installedAt,
          requiresRestart: isReinstall,
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err, packageName }, "Failed to install external adapter");
      const out = message.includes("npm") || message.includes("ERR!")
        ? `npm install failed: ${message}`
        : `Failed to install adapter: ${message}`;
      return new Response(JSON.stringify({ error: out }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    }
  });

  // GET /api/adapters/:type — single adapter detail
  app.get("/api/adapters/:type", async ({ request, actor, params }) => {
    const authActor = await resolveActor(options, { request, actor });
    assertBoardOrgAccess(authActor);
    const adapterType = params.type;
    const adapter = findServerAdapter(adapterType);
    if (!adapter) throw notFound(`Adapter "${adapterType}" is not registered.`);
    const externalRecord = getAdapterPluginByType(adapterType);
    const disabledSet = new Set(getDisabledAdapterTypes());
    return buildAdapterInfo(adapter, externalRecord, disabledSet);
  });

  // PATCH /api/adapters/:type — enable/disable adapter
  app.patch("/api/adapters/:type", async ({ request, actor, params, body }) => {
    const authActor = await resolveActor(options, { request, actor });
    assertInstanceAdmin(authActor);
    assertAdapterManagementVisible();

    const adapterType = params.type;
    const { disabled } = (body ?? {}) as { disabled?: boolean };
    if (typeof disabled !== "boolean") {
      throw badRequest('Request body must include { "disabled": true|false }.');
    }
    const existing = findServerAdapter(adapterType);
    if (!existing) throw notFound(`Adapter "${adapterType}" is not registered.`);

    const changed = setAdapterDisabled(adapterType, disabled);
    if (changed) logger.info({ type: adapterType, disabled }, "Adapter enabled/disabled");
    return { type: adapterType, disabled, changed };
  });

  // PATCH /api/adapters/:type/override — pause/resume override of a builtin
  app.patch("/api/adapters/:type/override", async ({ request, actor, params, body }) => {
    const authActor = await resolveActor(options, { request, actor });
    assertInstanceAdmin(authActor);
    assertAdapterManagementVisible();

    const adapterType = params.type;
    const { paused } = (body ?? {}) as { paused?: boolean };
    if (typeof paused !== "boolean") {
      throw badRequest('"paused" (boolean) is required in request body.');
    }
    if (!BUILTIN_ADAPTER_TYPES.has(adapterType)) {
      throw badRequest(`Type "${adapterType}" is not a builtin adapter.`);
    }
    const changed = setOverridePaused(adapterType, paused);
    logger.info({ type: adapterType, paused, changed }, "Adapter override toggle");
    return { type: adapterType, paused, changed };
  });

  // DELETE /api/adapters/:type — unregister an external adapter
  app.delete("/api/adapters/:type", async ({ request, actor, params }) => {
    const authActor = await resolveActor(options, { request, actor });
    assertInstanceAdmin(authActor);
    assertAdapterManagementVisible();

    const adapterType = params.type;
    if (!adapterType) throw badRequest("Adapter type is required.");
    if (BUILTIN_ADAPTER_TYPES.has(adapterType) && !getAdapterPluginByType(adapterType)) {
      throw forbidden(`Cannot remove built-in adapter "${adapterType}".`);
    }
    const existing = findServerAdapter(adapterType);
    if (!existing) throw notFound(`Adapter "${adapterType}" is not registered.`);
    const externalRecord = getAdapterPluginByType(adapterType);
    if (!externalRecord) throw notFound(`Adapter "${adapterType}" is not an externally installed adapter.`);

    if (externalRecord.packageName && !externalRecord.localPath) {
      try {
        const pluginsDir = getAdapterPluginsDir();
        await execFileAsync("npm", ["uninstall", externalRecord.packageName], {
          cwd: pluginsDir,
          timeout: 60_000,
        });
        logger.info(
          { type: adapterType, packageName: externalRecord.packageName },
          "npm uninstall completed for external adapter",
        );
      } catch (err) {
        logger.warn(
          { err, type: adapterType, packageName: externalRecord.packageName },
          "npm uninstall failed for external adapter; continuing with unregister",
        );
      }
    }

    unregisterServerAdapter(adapterType);
    removeAdapterPlugin(adapterType);
    logger.info({ type: adapterType }, "External adapter unregistered and removed");
    return { type: adapterType, removed: true };
  });

  // POST /api/adapters/:type/reload — runtime dev reload
  app.post("/api/adapters/:type/reload", async ({ request, actor, params }) => {
    const authActor = await resolveActor(options, { request, actor });
    assertInstanceAdmin(authActor);
    assertAdapterManagementVisible();

    const type = params.type;
    if (BUILTIN_ADAPTER_TYPES.has(type) && !getAdapterPluginByType(type)) {
      throw badRequest("Cannot reload built-in adapter.");
    }
    try {
      const newModule = await reloadExternalAdapter(type);
      if (!newModule) throw notFound(`Adapter "${type}" is not an externally installed adapter.`);

      unregisterServerAdapter(type);
      registerWithSessionManagement(newModule);
      configSchemaCache.delete(type);

      const record = getAdapterPluginByType(type);
      let newVersion: string | undefined;
      if (record) {
        newVersion = readAdapterPackageVersionFromDisk(record);
        if (newVersion) addAdapterPlugin({ ...record, version: newVersion });
      }
      logger.info({ type, version: newVersion }, "External adapter reloaded at runtime");
      return { type, version: newVersion, reloaded: true };
    } catch (err) {
      if (err instanceof HttpError) throw err;
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err, type }, "Failed to reload external adapter");
      throw new HttpError(500, `Failed to reload adapter: ${message}`);
    }
  });

  // POST /api/adapters/:type/reinstall — pull latest from npm
  app.post("/api/adapters/:type/reinstall", async ({ request, actor, params }) => {
    const authActor = await resolveActor(options, { request, actor });
    assertInstanceAdmin(authActor);
    assertAdapterCodeInstallAllowed();
    assertAdapterManagementVisible();

    const type = params.type;
    if (BUILTIN_ADAPTER_TYPES.has(type) && !getAdapterPluginByType(type)) {
      throw badRequest("Cannot reinstall built-in adapter.");
    }
    const record = getAdapterPluginByType(type);
    if (!record) throw notFound(`Adapter "${type}" is not an externally installed adapter.`);
    if (record.localPath) throw badRequest("Local-path adapters cannot be reinstalled. Use Reload instead.");

    try {
      const pluginsDir = getAdapterPluginsDir();
      logger.info({ type, packageName: record.packageName }, "Reinstalling adapter package via npm");
      await execFileAsync("npm", ["install", "--no-save", record.packageName], {
        cwd: pluginsDir,
        timeout: 120_000,
      });

      const newModule = await reloadExternalAdapter(type);
      if (!newModule) {
        throw new HttpError(500, "npm install succeeded but adapter reload failed.");
      }

      unregisterServerAdapter(type);
      registerWithSessionManagement(newModule);
      configSchemaCache.delete(type);

      let newVersion: string | undefined;
      const updatedRecord = getAdapterPluginByType(type);
      if (updatedRecord) {
        newVersion = readAdapterPackageVersionFromDisk(updatedRecord);
        if (newVersion) addAdapterPlugin({ ...updatedRecord, version: newVersion });
      }
      logger.info({ type, version: newVersion }, "Adapter reinstalled from npm");
      return { type, version: newVersion, reinstalled: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err, type }, "Failed to reinstall adapter");
      throw new HttpError(500, `Reinstall failed: ${message}`);
    }
  });

  // GET /api/adapters/:type/config-schema — declarative UI form schema
  app.get("/api/adapters/:type/config-schema", async ({ request, actor, params }) => {
    const authActor = await resolveActor(options, { request, actor });
    assertBoardOrgAccess(authActor);
    const { type } = params;

    const adapter = findActiveServerAdapter(type);
    if (!adapter) throw notFound(`Adapter "${type}" is not registered.`);
    if (!adapter.getConfigSchema) throw notFound(`Adapter "${type}" does not provide a config schema.`);

    const cached = configSchemaCache.get(type);
    if (cached && cached.adapter === adapter && Date.now() - cached.fetchedAt < CONFIG_SCHEMA_TTL_MS) {
      return cached.schema;
    }
    try {
      const schema = await adapter.getConfigSchema();
      configSchemaCache.set(type, { adapter, schema, fetchedAt: Date.now() });
      return schema;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err, type }, "Failed to resolve config schema");
      throw new HttpError(500, `Failed to resolve config schema: ${message}`);
    }
  });

  // GET /api/adapters/:type/ui-parser.js — self-contained ESM UI parser
  app.get("/api/adapters/:type/ui-parser.js", async ({ request, actor, params, set }) => {
    const authActor = await resolveActor(options, { request, actor });
    assertBoardOrgAccess(authActor);
    const { type } = params;
    const source = getOrExtractUiParserSource(type);
    if (!source) throw notFound(`No UI parser available for adapter "${type}".`);
    set.headers["content-type"] = "application/javascript; charset=utf-8";
    return source;
  });

  return app;
}
