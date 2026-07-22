// Enterprise API + mock adapter (task §8, §17).
//
// This module is the SINGLE adapter the operator console components use to
// reach the backend. It REUSES the existing `api` (frontend/js/api.js) for every
// contract that already exists (content, walls, layouts, broadcast, live-stream,
// presentations, scenes, displays) and adds documented MOCK contracts for the
// enterprise-specific surfaces that are NOT yet exposed by the backend. Each
// mock is clearly marked and documented in docs/ui-ux/backend-contract-gaps.md
// so the integration phase can swap mocks for real endpoints without touching
// component code.
//
// The real `api` is imported LAZILY (only when a live endpoint is actually
// called) so this module is safe to import in pure-node tests (it does not
// require fetch/io/localStorage at load time). Set globalThis.__MC_ENTERPRISE_MOCK_ONLY
// to force mocks (used by the test harness ONLY). Production must NEVER set that
// flag; a production-safety test (enterprise-api.test.js) proves production
// mode rejects mock fallback.
//
// PRODUCTION SAFETY (task §8): when not in MOCK_ONLY mode, a missing or failing
// backend contract throws an explicit Error with a `code` (never silently returns
// mock data or fake success). Components map the code via error-recovery.js to a
// visible disabled/reason state. Production code must not silently fall back to mocks.

const MOCK_ONLY = (typeof globalThis !== 'undefined' && globalThis.__MC_ENTERPRISE_MOCK_ONLY) === true;

function unavailableError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

let _api = null;
async function realApi() {
  if (_api) return _api;
  const mod = await import('../api.js');
  _api = mod.api || mod.default?.api;
  return _api;
}

// ---------------------------------------------------------------------------
// Topology / room overview
// The room OVERVIEW is derived primarily from the room snapshot (operator
// store). The adapter only supplies the topology/catalog options (rooms list,
// supported layout catalog) which are not part of the snapshot.
// ---------------------------------------------------------------------------

const ROOMS_MOCK = Object.freeze([
  { id: 'classroom-1', name: 'Classroom 1', isDefault: true },
  { id: 'classroom-2', name: 'Classroom 2' },
]);

export const enterpriseApi = {
  rooms: {
    // Gap G-01 (Resolution C): no GET /api/rooms endpoint exists. In production
    // this throws ROOMS_CATALOG_UNAVAILABLE so the room selector can show an
    // explicit "rooms catalog unavailable" reason and fall back to the single
    // configured room. MOCK_ONLY returns a fixture for the test harness.
    async list() {
      if (MOCK_ONLY) return Promise.resolve(ROOMS_MOCK);
      throw unavailableError('ROOMS_CATALOG_UNAVAILABLE', 'Rooms catalog endpoint is not available');
    },
  },

  // ---------------------------------------------------------------------------
  // Universal layout catalog (task §7). This is a PRESENTATION catalog: the
  // visual layout cards the operator chooses. It is resolved against the live
  // topology (operator store) to compute availability per card. The actual
  // application still routes through the EXISTING revision-safe wall layout
  // endpoint (api.setWallLayout / PUT /api/walls/:id/layout) and broadcast —
  // we do NOT add a competing layout endpoint.
  // ---------------------------------------------------------------------------
  layouts: {
    // The fixed catalog of operator-facing layout intents. `key` is stable for
    // i18n/test purposes; `requires` is the min physical display count needed.
    // Topology-specific availability is computed by layouts.availability().
    catalog: Object.freeze([
      { key: 'single', minDisplays: 1, audioAuthority: 'display' },
      { key: 'mirror', minDisplays: 2, audioAuthority: 'primary' },
      { key: 'span-two', minDisplays: 2, audioAuthority: 'primary' },
      { key: 'span-three', minDisplays: 3, audioAuthority: 'primary' },
      { key: 'span-five', minDisplays: 5, audioAuthority: 'primary' },
      { key: 'two-plus-one', minDisplays: 3, audioAuthority: 'primary' },
      { key: 'independent', minDisplays: 2, audioAuthority: 'each' },
      { key: 'content-fullscreen', minDisplays: 1, audioAuthority: 'display' },
      { key: 'content-with-camera-pip', minDisplays: 1, audioAuthority: 'display' },
      { key: 'camera-fullscreen', minDisplays: 1, audioAuthority: 'camera' },
      { key: 'camera-with-content-pip', minDisplays: 1, audioAuthority: 'camera' },
      { key: 'side-by-side', minDisplays: 2, audioAuthority: 'primary' },
      { key: 'custom-saved', minDisplays: 1, audioAuthority: 'display' },
      { key: 'clear', minDisplays: 0, audioAuthority: 'none' },
      { key: 'restore-previous', minDisplays: 0, audioAuthority: 'inherit' },
    ]),
    // Compute per-card availability for a given topology (displayCount).
    availability(displayCount = 0) {
      return this.catalog.map((card) => {
        const available = displayCount >= card.minDisplays;
        return {
          ...card,
          available,
          unavailableReason: available ? null : 'needs_more_displays',
        };
      });
    },
  },

  // ---------------------------------------------------------------------------
  // Content selection (task §8). Reuses api.getGovernedContent; the adapter
  // normalizes the filter vocabulary the console uses into the existing query
  // params. MOCK-only mode returns a fixture so Playwright tests don't need a
  // live backend.
  // ---------------------------------------------------------------------------
  content: {
    async list(filters = {}) {
      if (MOCK_ONLY) return MOCK_CONTENT_FIXTURE(filters);
      // Production: use the real governed-content endpoint. If it fails, throw
      // the error — the content selector shows the failure reason. No mock fallback.
      const api = await realApi();
      return await api.getGovernedContent({
        folder_id: filters.folderId,
        visibility: filters.visibility,
        type: filters.type,
        search: filters.search,
        owner: filters.mine ? 'me' : undefined,
        archived: filters.archived ? true : undefined,
      });
    },
    visibilityLevels: Object.freeze(['private', 'workspace_shared', 'organization_shared', 'platform_template']),
    filterFacets: Object.freeze(['recent', 'favorites', 'mine', 'workspace_shared', 'organization_shared', 'templates', 'type', 'owner', 'processing', 'archived']),
  },

  // ---------------------------------------------------------------------------
  // Playback confirmed state (task §9). Confirmed observed state comes from
  // the operator store (room snapshot confirmedState.displays). The adapter
  // exposes a typed accessor plus the existing transport command path.
  // ---------------------------------------------------------------------------
  playback: {
    transport(deviceId, action, adapter) {
      // adapter.sendCommand passthrough; kept here so components import one API.
      return adapter.sendCommand(deviceId, 'transport', { action });
    },
  },

  // ---------------------------------------------------------------------------
  // Screen-share diagnostics (task §10). Reuses the existing
  // screen-share-engine (frontend/js/services/screen-share-engine.js) via the
  // adapter consumer; no new endpoint. Mock returns a DEGRADED fixture for tests.
  // ---------------------------------------------------------------------------
  screenShare: {
    // Gap G-05: uses the existing screen-share-engine directly (real contract).
    // MOCK_ONLY returns a degraded fixture for the isolated test harness only.
    diagnostics(engine) {
      if (engine && typeof engine.getTargetDiagnostics === 'function') {
        return engine.getTargetDiagnostics();
      }
      if (MOCK_ONLY) return MOCK_SCREENSHARE_DIAGNOSTICS();
      throw unavailableError('SCREENSHARE_DIAGNOSTICS_UNAVAILABLE', 'Screen-share diagnostics engine is not available');
    },
  },

  // ---------------------------------------------------------------------------
  // Privacy / publishing (task §11). Reuses existing content governance
  // endpoints (contentCapabilities, publication requests). MOCK for tests.
  // ---------------------------------------------------------------------------
  privacy: {
    // Gap G-06 (Resolution C): the visibility/publication endpoints may not yet
    // exist on api.js. In production, a missing method throws an explicit error
    // so the publishing UI shows "feature unavailable" and disables the action.
    // NEVER return fake success.
    async requestOrganizationPublication(contentId) {
      if (MOCK_ONLY) return { ok: true, status: 'requested' };
      const api = await realApi();
      if (typeof api.requestOrganizationPublication !== 'function') {
        throw unavailableError('PUBLICATION_UNAVAILABLE', 'Organization publication endpoint is not available');
      }
      return await api.requestOrganizationPublication(contentId);
    },
    async setVisibility(contentId, visibility) {
      if (MOCK_ONLY) return { ok: true, visibility };
      const api = await realApi();
      if (typeof api.setContentVisibility !== 'function') {
        throw unavailableError('VISIBILITY_UNAVAILABLE', 'Content visibility endpoint is not available');
      }
      return await api.setContentVisibility(contentId, visibility);
    },
  },
};

// --- Mock fixtures (only used when MOCK_ONLY or endpoint missing) ----------

function MOCK_CONTENT_FIXTURE(filters) {
  const items = [
    { id: 'c1', title: 'Intro Deck', type: 'slides', owner: 'me', visibility: 'private', processing: false, duration: null, slideCount: 24, inUse: false, thumbnail: null, compatible: true },
    { id: 'c2', title: 'Safety Video', type: 'video', owner: 'ops', visibility: 'workspace_shared', processing: false, duration: 184, slideCount: null, inUse: true, thumbnail: null, compatible: true },
    { id: 'c3', title: 'Site Map', type: 'image', owner: 'facilities', visibility: 'organization_shared', processing: false, duration: null, slideCount: null, inUse: false, thumbnail: null, compatible: true },
    { id: 'c4', title: 'Quarterly Report', type: 'pdf', owner: 'finance', visibility: 'platform_template', processing: true, duration: null, slideCount: null, inUse: false, thumbnail: null, compatible: true },
  ];
  if (filters?.mine) return items.filter((i) => i.owner === 'me');
  if (filters?.type) return items.filter((i) => i.type === filters.type);
  if (filters?.archived) return [];
  return items;
}

function MOCK_SCREENSHARE_DIAGNOSTICS() {
  return {
    videoTrack: true,
    audioTrack: false, // DEGRADED FALLBACK fixture
    resolution: '1280x720',
    frameRate: 15,
    transport: 'relay-jpeg',
    degraded: true,
    degradedReasons: ['video_only', 'no_audio', 'reduced_quality', 'reduced_frame_rate'],
  };
}

export default enterpriseApi;
