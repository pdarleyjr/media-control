'use strict';

/**
 * Phase 4: One-tap layout presets.
 *
 * Generates a standard set of layout_zones for an existing layout using the
 * EXACT percentage columns from the layout_zones table:
 *   x_percent, y_percent, width_percent, height_percent,
 *   z_index, zone_type, fit_mode, name, sort_order
 *
 * These presets are intentionally additive: they produce plain zone objects
 * that the existing zone insert/replace logic in routes/layouts.js consumes.
 * No schema changes; column names mirror schema.sql exactly.
 *
 * Width math note: to keep three-across columns summing to exactly 100 (and
 * avoid sub-pixel gaps on the player), we mirror the seeded 'tpl-thirds'
 * template and use 33.33 / 33.34 / 33.33 with cumulative x offsets.
 */

// Cumulative x offsets that pair with the 33.33 / 33.34 / 33.33 widths so a
// 3-across row spans exactly 0..100. Matches the seeded tpl-thirds template.
const THIRD_WIDTHS = [33.33, 33.34, 33.33];
const THIRD_X = [0, 33.33, 66.67];

/**
 * Build a single zone object. Centralizes the shape so every preset emits the
 * identical key set the route's INSERT expects.
 *
 * @param {object} z - partial zone (x/y/w/h, optional name/zone_type/fit_mode)
 * @param {number} index - position used for z_index + sort_order
 * @returns {object} zone object with all percentage + meta columns
 */
function zone(z, index) {
  return {
    name: z.name || `Zone ${index + 1}`,
    x_percent: z.x_percent,
    y_percent: z.y_percent,
    width_percent: z.width_percent,
    height_percent: z.height_percent,
    z_index: index,
    zone_type: z.zone_type || 'content',
    fit_mode: z.fit_mode || 'contain',
    sort_order: index,
  };
}

/**
 * PRESETS: map of presetKey -> { label, build() }.
 * build() returns the raw zone geometries; buildPresetZones() normalizes them
 * into full zone objects (z_index/sort_order/name/zone_type/fit_mode).
 */
const PRESETS = {
  // Single full-bleed source. 'cover' so the source fills the canvas.
  full: {
    label: 'Full',
    build: () => [
      { name: 'Full', x_percent: 0, y_percent: 0, width_percent: 100, height_percent: 100, fit_mode: 'cover' },
    ],
  },

  // 2x2 grid.
  quad: {
    label: 'Quad (2x2)',
    build: () => [
      { name: 'Top Left', x_percent: 0, y_percent: 0, width_percent: 50, height_percent: 50 },
      { name: 'Top Right', x_percent: 50, y_percent: 0, width_percent: 50, height_percent: 50 },
      { name: 'Bottom Left', x_percent: 0, y_percent: 50, width_percent: 50, height_percent: 50 },
      { name: 'Bottom Right', x_percent: 50, y_percent: 50, width_percent: 50, height_percent: 50 },
    ],
  },

  // Two side-by-side full-height columns.
  columns_2: {
    label: '2 Columns',
    build: () => [
      { name: 'Left', x_percent: 0, y_percent: 0, width_percent: 50, height_percent: 100 },
      { name: 'Right', x_percent: 50, y_percent: 0, width_percent: 50, height_percent: 100 },
    ],
  },

  // Three full-height columns (1x3). Mirrors seeded tpl-thirds widths.
  columns_3: {
    label: '3 Columns',
    build: () => [
      { name: 'Left', x_percent: THIRD_X[0], y_percent: 0, width_percent: THIRD_WIDTHS[0], height_percent: 100 },
      { name: 'Center', x_percent: THIRD_X[1], y_percent: 0, width_percent: THIRD_WIDTHS[1], height_percent: 100 },
      { name: 'Right', x_percent: THIRD_X[2], y_percent: 0, width_percent: THIRD_WIDTHS[2], height_percent: 100 },
    ],
  },

  // Two stacked full-width rows.
  rows_2: {
    label: '2 Rows',
    build: () => [
      { name: 'Top', x_percent: 0, y_percent: 0, width_percent: 100, height_percent: 50 },
      { name: 'Bottom', x_percent: 0, y_percent: 50, width_percent: 100, height_percent: 50 },
    ],
  },

  // One large main source plus two stacked sidebars on the right.
  main_sidebar: {
    label: 'Main + Sidebars',
    build: () => [
      { name: 'Main', x_percent: 0, y_percent: 0, width_percent: 70, height_percent: 100, fit_mode: 'cover' },
      { name: 'Sidebar Top', x_percent: 70, y_percent: 0, width_percent: 30, height_percent: 50 },
      { name: 'Sidebar Bottom', x_percent: 70, y_percent: 50, width_percent: 30, height_percent: 50 },
    ],
  },

  // 3x2 grid (6 zones). Columns mirror seeded tpl-thirds widths; two rows of 50%.
  six: {
    label: 'Six (3x2)',
    build: () => {
      const rows = [0, 50];
      const out = [];
      rows.forEach((y) => {
        THIRD_WIDTHS.forEach((w, col) => {
          out.push({
            x_percent: THIRD_X[col],
            y_percent: y,
            width_percent: w,
            height_percent: 50,
          });
        });
      });
      return out;
    },
  },
};

/**
 * Build the full array of zone objects for a given preset key.
 * Returns null for unknown keys so the caller can reject with 400.
 *
 * @param {string} presetKey
 * @returns {Array<object>|null} zone objects (immutable, freshly built) or null
 */
function buildPresetZones(presetKey) {
  const preset = PRESETS[presetKey];
  if (!preset) return null;
  return preset.build().map((z, i) => zone(z, i));
}

/**
 * @returns {string[]} the valid preset keys (for validation + UI listing).
 */
function presetKeys() {
  return Object.keys(PRESETS);
}

module.exports = { PRESETS, buildPresetZones, presetKeys };
