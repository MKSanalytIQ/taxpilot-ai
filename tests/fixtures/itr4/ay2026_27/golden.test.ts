import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "fs";
import path from "path";
import { generateITRJson } from "@/lib/itr-json/mapper";
import { validateITR4Json } from "@/lib/itr-json/validator/officialValidator";
import { TaxEngine } from "@/lib/tax/engine";
import { evaluateFilingGate } from "@/lib/validation/filingGate";
import type { NormalizedReturn } from "@/lib/tax/model";

const frozen = new Date("2026-08-26T00:00:00.000Z");
const root = path.join(process.cwd(), "tests/fixtures/itr4/ay2026_27");
const cases = ["simple", "professional", "salary-business", "business-interest", "tax-payable", "refund", "capital-gains-112a"];

describe("golden ITR-4 AY 2026-27 fixtures", () => {
  for (const name of cases) {
    it(`${name} matches stored expected JSON, tax and validation`, () => {
      const dir = path.join(root, name);
      expect(existsSync(path.join(dir, "input.json"))).toBe(true);
      const input = JSON.parse(readFileSync(path.join(dir, "input.json"), "utf8")) as NormalizedReturn;
      const expected = JSON.parse(readFileSync(path.join(dir, "expected.json"), "utf8"));
      const expectedTax = JSON.parse(readFileSync(path.join(dir, "expectedTax.json"), "utf8"));
      const expectedValidation = JSON.parse(readFileSync(path.join(dir, "expectedValidation.json"), "utf8"));
      const g = generateITRJson(input, { generatedAt: frozen, returnId: "fixture" });
      const calc = TaxEngine.calculate(input, frozen);
      const gate = evaluateFilingGate(input, "fixture", frozen);
      expect(g.official.schemaMode).toBe("OfficialSchema");
      if (expected) {
        expect(validateITR4Json(expected, "2026-27").valid).toBe(true);
        expect(JSON.stringify(g.json)).toBe(JSON.stringify(expected));
      }
      expect(calc.totalTax).toBe(expectedTax.totalTax);
      expect(calc.settlement.status).toBe(expectedTax.settlement.status);
      expect(gate.ready).toBe(expectedValidation.ready);
      expect(gate.layers).toEqual(expectedValidation.layers);
    });
  }
});
