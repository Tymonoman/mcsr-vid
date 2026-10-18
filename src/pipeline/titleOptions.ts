/**
 * Three title-hook options for a match's long-form, for the Telegram title picker
 * (src/telegram/titlePicker.ts) to put on buttons under the operator's thumbnail message.
 *
 * STUB — titles/policy (a parallel branch) replaces this file with the real picker: the model's
 * proposals and the `hooks.ts` chips, ranked and filtered through `hookProblem`. At merge time
 * theirs wins. This placeholder exists only so `titles/telegram` has something to import and
 * `npx tsc --noEmit` against until then; its tests inject options through a deps seam
 * (`setTitleOptionsImpl`, titlePicker.ts), never through this stub.
 */
export interface TitleOptions {
  options: string[];
  source: ("nicknames" | "model" | "chip")[];
  reason?: string;
}

export async function titleOptions(_matchId: number, _opts?: { fresh?: boolean }): Promise<TitleOptions> {
  return { options: [], source: [] };
}
