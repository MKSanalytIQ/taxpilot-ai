import { describe, expect, it } from "vitest";
import { fixtures } from "./fixtures";
import { confirmationsFromAnswers } from "./confirmations";
import { determineItrType, eligibilityFromNormalized } from "@/lib/tax-rules/ay2026_27/eligibility";

describe("prohibited income is not assumed away", () => {
  it("blocks lottery and racehorse income recorded on the return", () => {
    const lottery = eligibilityFromNormalized({
      ...fixtures.simpleBusiness,
      otherIncome: [{ kind: "Lottery", amount: 50_000, source: "State" }],
    });
    expect(lottery.lotteryOrRacehorse).toBe(true);
    expect(determineItrType(lottery).itr4Eligible).toBe(false);
    expect(determineItrType(lottery).reasons.some((reason) => /lottery/i.test(reason))).toBe(true);

    const racehorse = eligibilityFromNormalized({
      ...fixtures.simpleBusiness,
      incomeSources: ["RACEHORSE"],
    });
    expect(racehorse.lotteryOrRacehorse).toBe(true);
    expect(determineItrType(racehorse).itr4Eligible).toBe(false);
  });

  it("does not treat missing confirmations as false or zero", () => {
    const unknown = eligibilityFromNormalized({
      ...fixtures.simpleBusiness,
      eligibilityConfirmed: undefined,
    });
    expect(unknown.lotteryOrRacehorse).toBeNull();
    expect(unknown.foreignAssets).toBeNull();
    expect(unknown.unlistedShares).toBeNull();
    expect(unknown.fnoTrading).toBeNull();
    expect(unknown.agriculturalIncome).toBeNull();
    expect(unknown.isDirector).toBeNull();
    const result = determineItrType(unknown);
    expect(result.itr4Eligible).toBe(false);
    expect(result.reasons.some((reason) => /not been confirmed/i.test(reason))).toBe(true);
  });

  it("keeps an explicitly confirmed ordinary return on ITR-4", () => {
    const confirmed = eligibilityFromNormalized(fixtures.simpleBusiness, { totalIncome: 270_000 });
    expect(confirmed.lotteryOrRacehorse).toBe(false);
    expect(confirmed.agriculturalIncome).toBe(0);
    expect(determineItrType(confirmed).itr4Eligible).toBe(true);
  });

  it("accepts explicit No answers and blocks a Yes", () => {
    const answers = {
      DIRECTOR: "No",
      LOTTERY: "No",
      FOREIGN_ASSETS: "No",
      UNLISTED_SHARES: "No",
      FNO: "No",
      AGRICULTURE: "No",
    };
    const cleared = eligibilityFromNormalized(
      { ...fixtures.simpleBusiness, eligibilityConfirmed: confirmationsFromAnswers(answers) },
      { totalIncome: 270_000 },
    );
    expect(cleared.lotteryOrRacehorse).toBe(false);
    expect(cleared.agriculturalIncome).toBe(0);
    expect(determineItrType(cleared).itr4Eligible).toBe(true);

    const blocked = eligibilityFromNormalized({
      ...fixtures.simpleBusiness,
      eligibilityConfirmed: confirmationsFromAnswers({ ...answers, LOTTERY: "Yes" }),
    });
    expect(determineItrType(blocked).itr4Eligible).toBe(false);
  });

  it("uses a No director answer and still blocks a Yes", () => {
    const no = eligibilityFromNormalized(
      { ...fixtures.simpleBusiness, eligibilityConfirmed: undefined },
      { directorAnswer: "No" },
    );
    expect(no.isDirector).toBe(false);
    expect(no.lotteryOrRacehorse).toBeNull();

    const yes = eligibilityFromNormalized(fixtures.simpleBusiness, { directorAnswer: "Yes", totalIncome: 270_000 });
    expect(determineItrType(yes).itr4Eligible).toBe(false);
  });
});
