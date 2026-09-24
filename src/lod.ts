export const DESKTOP_LOD_BUDGETS = [3_000_000, 4_500_000, 6_000_000, 9_000_000] as const;
// Derived, never repeated: the conversion pipeline plans LOD levels against the largest preset, so a
// budget change has to move both halves together. The Node side carries its own copy of this number
// (desktop/lod-levels.mjs, DEFAULT_LOD_CEILING) because a plain Node child cannot import src/*.ts.
export const LOD_CEILING = DESKTOP_LOD_BUDGETS[DESKTOP_LOD_BUDGETS.length - 1];
export type LodAdvice = 'ok' | 'expected' | 'reconvert';
export type LodVerdict = { pinned:boolean; advice:LodAdvice; coarsest:number; budget:number; ceiling:number; detailedFrom:number };
/**
 * What to tell the user about the current preset, mirroring the allocator's own branches
 * (GSplatBudgetBalancer.balance): it pins the scene at its coarsest level when `coarsest >= budget`.
 * That is 'expected' -- a preset below the scene's coarsest level simply has nothing to upgrade --
 * unless the coarsest level also reaches the ceiling, because then no preset can ever add detail and
 * the scene has to be re-converted with more levels. `coarsest <= 0` means the index is not loaded yet.
 */
export function lodBudgetVerdict(input:{coarsest:number;budget:number;ceiling:number;budgets:readonly number[]}):LodVerdict {
  const {coarsest,budget,ceiling,budgets}=input;
  if(!(coarsest>0))return {pinned:false,advice:'ok',coarsest:0,budget,ceiling,detailedFrom:-1};
  return {pinned:coarsest>=budget,advice:coarsest>=ceiling?'reconvert':coarsest>=budget?'expected':'ok',coarsest,budget,ceiling,detailedFrom:budgets.findIndex(b=>coarsest<b)};
}
