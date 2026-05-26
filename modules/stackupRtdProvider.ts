import { ajax } from "../src/ajax.ts";
import { AllConsentData } from "../src/consentHandler.ts";
import { submodule } from "../src/hook.js";
import { StartAuctionOptions } from "../src/prebid.ts";
// import { StartAuctionOptions } from "../src/prebid.js";
import {
  getStorageManager,
  discloseStorageUse,
} from "../src/storageManager.js";
import { MODULE_TYPE_RTD } from "../src/activities/modules.js";
import {
  logInfo,
  logError,
  logWarn,
  deepAccess,
  cyrb53Hash,
} from "../src/utils.js";
import type { RTDProviderConfig, RtdProviderSpec } from "./rtdModule/spec.ts";

// TCF purposes required by stackupRtd:
//   1 = Store and/or access information on a device
//   4 = Select personalised content
const REQUIRED_PURPOSES = [1, 4];

const MODULE_NAME = "stackupRtd";
const MODULE_TYPE = "realTimeData";
const DEFAULT_TIMEOUT = 300;
const DEFAULT_API_URL = "https://api.stackup.ai/v1/enrich";
const CACHE_KEY_PREFIX = "stackup:enrich:v1:";
const CACHE_SCHEMA_VERSION = 1;

export const storage = getStorageManager({
  moduleType: MODULE_TYPE_RTD,
  moduleName: MODULE_NAME,
});

type RtdState =
  | "idle"
  | "initializing"
  | "fetching"
  | "ready"
  | "timedOut"
  | "error"
  | "merging";

interface RtdInternalState {
  state: RtdState;
  articleId: string | null;
  enrichment: EnrichmentSnapshot | null;
  fetchPromise: Promise<EnrichmentSnapshot> | null;
  pendingCallbacks: Array<() => void>;
  snapshotsByAuctionId: Map<string, EnrichmentSnapshot>;
  config: RTDProviderConfig<"stackupRtd">;
}

const state: RtdInternalState = {
  state: "idle",
  articleId: null,
  enrichment: null,
  fetchPromise: null,
  pendingCallbacks: [],
  snapshotsByAuctionId: new Map(),
  config: null as any,
};

export interface StackupRtdParams {
  apiUrl?: string; // default: "https://api.stackup.ai/v1/enrich"
  pubId: string; // Publisher ID issued by Stackup
  timeout?: number; // default: 300 ms
  articleId?: string;
  articleIdMode?: "explicit" | "path" | "title" | "auto";
  cache?: {
    enabled: boolean;
    ttlSeconds: number;
    storage: "session" | "memory";
  };
  debug?: boolean;
}

declare module "./rtdModule/spec.ts" {
  interface ProviderConfig {
    stackupRtd: {
      params?: StackupRtdParams;
    };
  }
}

type BrandSafetyBlock = unknown; // TODO: define properly when we have real data
type EmotionBlock = unknown; // TODO: define properly when we have real data

// types/stackup.ts — shared between RTD and analytics modules

export interface EnrichmentSnapshot {
  articleId: string;
  fetchedAt: number; // unix ms when enrichment landed
  source: "api" | "cache";
  site: {
    content: {
      id: string;
      title?: string;
      data: Ortb2ContentSegment[];
      ext?: {
        brand_safety?: BrandSafetyBlock;
        emotion?: EmotionBlock;
      };
    };
  };
  user: {
    data: Ortb2UserSegment[];
  };
}

export interface Ortb2ContentSegment {
  name: string; // provider domain, e.g. 'stackup-ai.com'
  ext: { segtax: 3 }; // IAB Content Taxonomy 3.1
  segment: Array<{
    id: string;
    name: string;
    ext?: { confidence: number };
  }>;
}

export interface Ortb2UserSegment {
  name: string;
  ext: { segtax: 4 }; // IAB Audience Taxonomy 1.1
  segment: Array<{
    id: string;
    name: string;
    ext?: { confidence: number };
  }>;
}

// Raw JSON shape returned by the Stackup enrichment API.
// Mirrors EnrichmentSnapshot.site/user but without the client-added fields
// (articleId, fetchedAt, source) that are stamped on after a successful fetch.
interface RawEnrichmentResponse {
  site: {
    content: {
      id?: string;
      title?: string;
      data: Ortb2ContentSegment[];
      ext?: {
        brand_safety?: BrandSafetyBlock;
        emotion?: EmotionBlock;
      };
    };
  };
  user?: {
    data?: Ortb2UserSegment[];
  };
}

/**
 * @typedef {import('../modules/rtdModule/index.js').RtdSubmodule} RtdSubmodule
 */

export const subModuleObj: RtdProviderSpec<"stackupRtd"> = {
  name: MODULE_NAME as "stackupRtd",
  init,
  getBidRequestData,
};

function init(
  config: RTDProviderConfig<"stackupRtd">,
  userConsent: AllConsentData
): boolean {
  // Disclose the sessionStorage key pattern to storageControl on first init.
  // Must be called after hook.ready() — init() is only invoked post-auction setup,
  // so this is always safe. discloseStorageUse is a sync hook that throws if called
  // before hook.ready() (fun-hooks queuing only applies to async hooks).
  discloseStorageUse(MODULE_NAME, {
    type: "web",
    identifier: CACHE_KEY_PREFIX + "*",
    purposes: REQUIRED_PURPOSES,
  });

  // Guard against being called with no config (defensive — framework shouldn't do this)
  if (!config) {
    logWarn("[stackupRtd] init called without config, module inert");
    state.state = "error";
    return true;
  }
  state.config = config;
  state.state = "initializing";

  // params and pubId are required — fail fast if missing
  const params = config.params;
  if (!params || !params.pubId) {
    logWarn("[stackupRtd] missing required params.pubId, module inert");
    state.state = "error";
    return true;
  }

  // Respect consent — no enrichment if user has not granted relevant purposes
  if (!hasRequiredConsent(userConsent)) {
    logInfo("[stackupRtd] consent not granted, module inert");
    state.state = "error";
    return true; // return true so Prebid still registers us
  }

  try {
    const { id } = resolveArticleId(params);
    state.articleId = id;
  } catch (e) {
    logError("[stackupRtd] article id resolution failed", e);
    state.state = "error";
    return true;
  }

  // Kick off background fetch — do not await
  if (!state.articleId) {
    logWarn("[stackupRtd] no article ID resolved, module inert");
    state.state = "error";
    return true;
  }
  state.fetchPromise = fetchEnrichment(state.articleId, params);
  state.state = "fetching";

  state.fetchPromise
    .then((data) => {
      state.enrichment = data;
      state.state = "ready";
      drainPendingCallbacks();
    })
    .catch((err) => {
      logError("[stackupRtd] fetch failed", err);
      state.state = "error";
      drainPendingCallbacks();
    });

  return true;
}

// Builds the enrichment API request URL from the resolved articleId and publisher params.
// TODO: link to Stackup API documentation once published.
function buildEnrichmentUrl(
  articleId: string,
  params: StackupRtdParams
): string {
  const base = params.apiUrl ?? DEFAULT_API_URL;
  const domain = window.location.hostname;
  return `${base}?pubId=${encodeURIComponent(
    params.pubId
  )}&articleId=${encodeURIComponent(articleId)}&domain=${encodeURIComponent(
    domain
  )}`;
}

// Flushes all getBidRequestData callbacks queued while the enrichment fetch was in flight.
// Called once the fetch settles (success or error) to unblock any waiting auctions.
function drainPendingCallbacks(): void {
  const callbacks = state.pendingCallbacks.splice(0);
  for (const cb of callbacks) {
    try {
      cb();
    } catch (e) {
      logError("[stackupRtd] pending callback threw", e);
    }
  }
}

function fetchEnrichment(
  articleId: string,
  params: StackupRtdParams
): Promise<EnrichmentSnapshot> {
  // Check cache first
  const cached = getCachedEnrichment(articleId);
  if (cached) {
    return Promise.resolve({ ...cached, source: "cache" });
  }

  return new Promise((resolve, reject) => {
    const url = buildEnrichmentUrl(articleId, params);
    const timeoutId = setTimeout(
      () => reject(new Error("fetch timeout")),
      (params.timeout ?? DEFAULT_TIMEOUT) + 50
    );

    ajax(
      url,
      {
        success: (response: string) => {
          clearTimeout(timeoutId);
          try {
            const data = JSON.parse(response);
            if (!isValidEnrichment(data)) {
              return reject(new Error("schema validation failed"));
            }
            const snapshot: EnrichmentSnapshot = {
              articleId,
              fetchedAt: Date.now(),
              source: "api",
              site: {
                content: {
                  ...data.site.content,
                  id: data.site.content.id ?? articleId,
                },
              },
              user: { data: data.user?.data ?? [] },
            };
            setCachedEnrichment(articleId, snapshot);
            resolve(snapshot);
          } catch (e) {
            reject(e);
          }
        },
        error: (err: any) => {
          clearTimeout(timeoutId);
          reject(err);
        },
      },
      null,
      { method: "GET", withCredentials: false }
    );
  });
}

function isValidEnrichment(data: any): data is RawEnrichmentResponse {
  if (!data || typeof data !== "object") return false;
  if (!data.site?.content) return false;
  if (!Array.isArray(data.site.content.data)) return false;

  // Validate every segment in site.content.data
  for (const block of data.site.content.data) {
    if (typeof block.name !== "string") return false;
    if (block.ext?.segtax !== 3) return false; // must be IAB Content Taxonomy 3.1
    if (!Array.isArray(block.segment)) return false;
    for (const seg of block.segment) {
      if (typeof seg.id !== "string") return false;
      if (typeof seg.name !== "string") return false;
      if (seg.ext?.confidence !== undefined) {
        if (typeof seg.ext.confidence !== "number") return false;
        if (seg.ext.confidence < 0 || seg.ext.confidence > 1) return false;
      }
    }
  }

  // user.data is optional — some articles have site-level enrichment only
  if (data.user?.data && !Array.isArray(data.user.data)) return false;

  return true;
}

function getCachedEnrichment(articleId: string): EnrichmentSnapshot | null {
  try {
    const raw = storage.getDataFromSessionStorage(CACHE_KEY_PREFIX + articleId);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed.v !== CACHE_SCHEMA_VERSION) return null;
    const ttlMs = (state.config?.params?.cache?.ttlSeconds ?? 3600) * 1000;
    if (Date.now() - parsed.t > ttlMs) return null;
    return parsed.d;
  } catch {
    return null;
  }
}

function setCachedEnrichment(
  articleId: string,
  data: EnrichmentSnapshot
): void {
  try {
    storage.setDataInSessionStorage(
      CACHE_KEY_PREFIX + articleId,
      JSON.stringify({ v: CACHE_SCHEMA_VERSION, t: Date.now(), d: data })
    );
  } catch {
    // quota exceeded — silently ignore
  }
}

function hasRequiredConsent(userConsent: AllConsentData): boolean {
  // COPPA: all enrichment must be blocked for child-directed contexts.
  if (userConsent.coppa === true) return false;

  // USP / CCPA: position 2 of the 1.0 string is the opt-out-of-sale flag;
  // 'Y' means the user has opted out.
  const usp = deepAccess(userConsent, "usp");
  if (typeof usp === "string" && usp[2] === "Y") return false;

  // GPP: US-law sections (>= 5) indicate an active US state privacy law.
  // Block conservatively until section-specific opt-out parsing is available.
  const gppSections: number[] | undefined = deepAccess(
    userConsent,
    "gpp.applicableSections"
  );
  if (Array.isArray(gppSections) && gppSections.some((s) => s >= 5)) {
    return false;
  }

  // GDPR: require per-purpose consent when GDPR applies.
  const gdprApplies = deepAccess(userConsent, "gdpr.gdprApplies");
  if (!gdprApplies) return true;

  const purposeConsents =
    deepAccess(userConsent, "gdpr.vendorData.purpose.consents") || {};
  const purposeLegitimateInterests =
    deepAccess(userConsent, "gdpr.vendorData.purpose.legitimateInterests") ||
    {};

  return REQUIRED_PURPOSES.every(
    (id) =>
      purposeConsents[id] === true || purposeLegitimateInterests[id] === true
  );
}

function resolveArticleId(params: StackupRtdParams): {
  id: string | null;
  source: "explicit" | "path" | "title" | null;
} {
  const mode = params.articleIdMode ?? "auto";

  // Strategy 1: explicit
  if (mode === "explicit" || mode === "auto") {
    if (params.articleId && typeof params.articleId === "string") {
      const id = params.articleId.trim();
      if (id.length > 0 && id.length <= 128) {
        return { id, source: "explicit" };
      }
    }
    if (mode === "explicit") return { id: null, source: null };
  }

  // Strategy 2: path
  if (mode === "path" || mode === "auto") {
    const id = resolveFromPath();
    if (id) return { id, source: "path" };
    if (mode === "path") return { id: null, source: null };
  }

  // Strategy 3: title
  if (mode === "title" || mode === "auto") {
    const id = resolveFromTitle();
    if (id) return { id, source: "title" };
  }

  return { id: null, source: null };
}

function resolveFromPath(): string | null {
  try {
    let path = window.location.pathname;

    // Normalize: lowercase, strip trailing slash
    path = path.toLowerCase().replace(/\/+$/, "");

    // Strip common locale prefixes
    path = path.replace(
      /^\/(en|us|uk|de|fr|es|it|jp|kr|cn)(-[a-z]{2})?\//,
      "/"
    );

    // Strip tracking params that leak into path on some sites
    path = path.replace(/\/_amp\//, "/").replace(/\/amp\/?$/, "");

    // Must look like an article path, not a section front
    // Heuristic: at least 2 path segments and total length > 20
    const segments = path.split("/").filter(Boolean);
    if (segments.length < 2) return null;
    if (path.length < 20) return null;

    // WHY HASH THE PATH INSTEAD OF USING IT DIRECTLY:
    // Raw paths can be long (100+ chars), contain special characters that need
    // URL-encoding, and may leak information we do not want in cache keys or
    // analytics payloads. cyrb53 gives a fixed-length, URL-safe, stable
    // identifier. 16 hex characters (64 bits) gives ~1.8e19 possible values —
    // more than enough to avoid collisions within any publisher's article corpus.
    // We prefix with 'path_' so analytics can distinguish explicit IDs from
    // derived ones at a glance.
    return "path_" + cyrb53Hash(path).toString(16).slice(0, 16);
  } catch {
    return null;
  }
}

function resolveFromTitle(): string | null {
  try {
    const title = (document.title || "").trim();
    if (title.length < 10) return null;

    // Strip common publisher suffixes
    const stripped = title
      .replace(/\s*[-|·]\s*[^\-|·]+$/, "") // strip '| PublisherName' or '- PublisherName'
      .trim();

    if (stripped.length < 10) return null;
    return (
      "title_" + cyrb53Hash(stripped.toLowerCase()).toString(16).slice(0, 16)
    );
  } catch {
    return null;
  }
}

function getBidRequestData(
  reqBidsConfigObj: StartAuctionOptions,
  callback: () => void,
  config: RTDProviderConfig<"stackupRtd">
): void {
  const timeoutMs = config.params?.timeout ?? DEFAULT_TIMEOUT;
  let callbackFired = false;
  const release = () => {
    if (callbackFired) return; // CRITICAL — never call back twice
    callbackFired = true;
    callback();
  };

  // Safety net — always release the auction, no matter what
  const timeoutId = setTimeout(() => {
    if (state.state === "fetching") {
      logWarn(
        "[stackupRtd] enrichment fetch exceeded " +
          timeoutMs +
          "ms, releasing auction clean"
      );
      state.state = "timedOut";
    }
    release();
  }, timeoutMs);

  const onReady = () => {
    clearTimeout(timeoutId);
    if (state.enrichment) {
      try {
        mergeIntoOrtb2(reqBidsConfigObj, state.enrichment);
        // Stash snapshot keyed by auctionId so analytics adapter can retrieve it
        if (reqBidsConfigObj.auctionId) {
          state.snapshotsByAuctionId.set(
            reqBidsConfigObj.auctionId,
            state.enrichment
          );
        }
      } catch (e) {
        logError("[stackupRtd] merge failed, auction proceeds clean", e);
      }
    }
    release();
  };

  if (state.state === "ready") {
    onReady();
  } else if (state.state === "fetching") {
    state.pendingCallbacks.push(onReady);
  } else {
    // error, timedOut, idle — give up cleanly
    clearTimeout(timeoutId);
    release();
  }
}

function mergeIntoOrtb2(
  reqBidsConfigObj: StartAuctionOptions,
  enrichment: EnrichmentSnapshot
): void {
  const global = reqBidsConfigObj.ortb2Fragments?.global ?? {};
  reqBidsConfigObj.ortb2Fragments = reqBidsConfigObj.ortb2Fragments ?? {};
  reqBidsConfigObj.ortb2Fragments.global = global;

  mergeSiteContent(global, enrichment.site.content);
  mergeUserData(global, enrichment.user.data);
}

function mergeSiteContent(global: any, ours: any): void {
  global.site = global.site ?? {};
  global.site.content = global.site.content ?? { data: [] };
  const target = global.site.content;

  target.id = target.id ?? ours.id;
  target.title = target.title ?? ours.title;

  // Array merge by provider name
  target.data = target.data ?? [];
  for (const ourBlock of ours.data) {
    const existingIdx = target.data.findIndex(
      (b: any) => b.name === ourBlock.name
    );
    if (existingIdx >= 0) {
      target.data[existingIdx] = dedupeSegments(ourBlock);
    } else {
      target.data.push(dedupeSegments(ourBlock));
    }
  }

  // Extension merge — publisher wins on conflict
  target.ext = target.ext ?? {};
  if (!target.ext.brand_safety && ours.ext?.brand_safety) {
    target.ext.brand_safety = ours.ext.brand_safety;
  }
  if (!target.ext.emotion && ours.ext?.emotion) {
    target.ext.emotion = ours.ext.emotion;
  }
}

function mergeUserData(global: any, ours: any[]): void {
  global.user = global.user ?? {};
  global.user.data = global.user.data ?? [];

  for (const ourBlock of ours) {
    const existingIdx = global.user.data.findIndex(
      (b: any) => b.name === ourBlock.name
    );
    if (existingIdx >= 0) {
      global.user.data[existingIdx] = dedupeSegments(ourBlock);
    } else {
      global.user.data.push(dedupeSegments(ourBlock));
    }
  }
}

function dedupeSegments(block: any): any {
  const byId = new Map<string, any>();
  for (const seg of block.segment) {
    const existing = byId.get(seg.id);
    if (!existing) {
      byId.set(seg.id, seg);
      continue;
    }
    const ourConf = seg.ext?.confidence ?? 0;
    const theirConf = existing.ext?.confidence ?? 0;
    if (ourConf > theirConf) byId.set(seg.id, seg);
  }
  return { ...block, segment: Array.from(byId.values()) };
}

function registerSubmodule() {
  submodule(MODULE_TYPE, subModuleObj as unknown as RtdProviderSpec<string>);
}

registerSubmodule();

// Exported only for unit tests — resets the module-level singleton between test cases.
export function _resetStateForTesting(): void {
  state.state = "idle";
  state.articleId = null;
  state.enrichment = null;
  state.fetchPromise = null;
  state.pendingCallbacks.length = 0;
  state.snapshotsByAuctionId.clear();
  state.config = null as any;
}
