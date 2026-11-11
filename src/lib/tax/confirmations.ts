import { ITR4_AGRI_CAP } from "@/lib/tax-rules/ay2026_27/eligibility";
import type { NormalizedReturn } from "./model";

export type EligibilityAnswers = Record<string, string | undefined>;

function yesNo(value: string | undefined): boolean | undefined {
  if (value === "Yes") return true;
  if (value === "No") return false;
  return undefined;
}

/** Explicit Yes/No answers only. Anything else stays unknown. */
export function confirmationsFromAnswers(answers: EligibilityAnswers): NormalizedReturn["eligibilityConfirmed"] {
  const confirmed: NonNullable<NormalizedReturn["eligibilityConfirmed"]> = {};
  const director = yesNo(answers.DIRECTOR);
  const lottery = yesNo(answers.LOTTERY);
  const foreignAssets = yesNo(answers.FOREIGN_ASSETS);
  const unlisted = yesNo(answers.UNLISTED_SHARES);
  const fno = yesNo(answers.FNO);
  const agriculture = yesNo(answers.AGRICULTURE);
  if (director !== undefined) confirmed.isDirector = director;
  if (lottery !== undefined) confirmed.lotteryOrRacehorse = lottery;
  if (foreignAssets !== undefined) confirmed.foreignAssets = foreignAssets;
  if (unlisted !== undefined) confirmed.unlistedShares = unlisted;
  if (fno !== undefined) confirmed.fnoTrading = fno;
  if (agriculture === false) confirmed.agriculturalIncome = 0;
  if (agriculture === true) confirmed.agriculturalIncome = ITR4_AGRI_CAP + 1;
  return Object.keys(confirmed).length ? confirmed : undefined;
}
