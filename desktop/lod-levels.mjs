// LOD level planning for the conversion pipeline.
//
// Why this exists: the viewer hands the official splat allocator a per-preset point budget, and the
// allocator pins a whole scene at its coarsest level as soon as that level alone reaches the budget
// (GSplatBudgetBalancer.balance -> _assignChainEnd(false), triggered by `startCount >= budget`). A
// fixed three-level chain therefore degrades large scenes to "coarsest only": every preset renders
// the same level and none of them can add detail. The level count has to follow the source size.
//
// Keep in sync with src/lod.ts (LOD_CEILING / lodBudgetVerdict), which is the viewer half of the same
// rule. src/ cannot import this file (tsconfig has no allowJs) and this file must not import src/, so
// the two halves are held together by the unit tests in tests/core.test.mjs instead of an import.
//
// No `node:` imports on purpose: the official Node child process and the tests both
// load this file as-is, with no build step.

export const MIN_LOD_LEVELS = 3; // 100% / 50% / 25%: the chain every scene converted so far has.
export const MAX_LOD_LEVELS = 16; // Format limit, mirrored by src/manifest.ts and validateLodMeta.
export const DEFAULT_LOD_CEILING = 9_000_000; // max(DESKTOP_LOD_BUDGETS).

/** Point target of the coarsest level after `levels` levels of halving. */
export const coarsestAt = (points, levels) => Math.max(1, Math.ceil(points / 2 ** (levels - 1)));

/**
 * How many LOD levels to generate: at least MIN, halving until the coarsest level fits the ceiling.
 *
 * The bound is strict, and that matters: the allocator pins on `startCount >= budget`, so a coarsest
 * level exactly equal to the ceiling is still pinned -- the viewer would then ask the user to
 * re-convert a scene this function had just planned. Hence `>=` in the loop condition.
 */
export function planLodLevels(points, ceiling) {
  if (!Number.isSafeInteger(points) || points < 1) throw new Error(`planLodLevels: points must be a positive safe integer, got ${points}`);
  if (!Number.isSafeInteger(ceiling) || ceiling < 1) throw new Error(`planLodLevels: ceiling must be a positive safe integer, got ${ceiling}`);
  let levels = MIN_LOD_LEVELS;
  while (levels < MAX_LOD_LEVELS && coarsestAt(points, levels) >= ceiling) levels++;
  return levels;
}
