import { prisma } from "./db";
import { json } from "./utils";

type Source = string;

const DEFAULT_OPTIONS = ["Yes", "No", "Not sure"];

const ELIGIBILITY_QUESTIONS: Array<{ code: string; prompt: string; helpText: string; options: string[] }> = [
  {
    code: "LOTTERY",
    prompt: "Did you have lottery winnings or income from owning and maintaining race horses?",
    helpText: "This income is not allowed in ITR-4. TaxPilot will not assume the answer is No.",
    options: ["Yes", "No", "Not sure"],
  },
  {
    code: "FOREIGN_ASSETS",
    prompt: "Did you have foreign assets or foreign income during the year?",
    helpText: "Foreign assets or income cannot be reported in ITR-4.",
    options: ["Yes", "No", "Not sure"],
  },
  {
    code: "UNLISTED_SHARES",
    prompt: "Did you hold unlisted equity shares at any time during the year?",
    helpText: "Holding unlisted equity shares is not permitted in ITR-4.",
    options: ["Yes", "No", "Not sure"],
  },
  {
    code: "FNO",
    prompt: "Did you have futures, options, or other speculative trading income?",
    helpText: "F&O and speculative trading are reported in ITR-3, not ITR-4.",
    options: ["Yes", "No", "Not sure"],
  },
  {
    code: "AGRICULTURE",
    prompt: "Was your agricultural income above ₹5,000?",
    helpText: "Agricultural income above ₹5,000 is not permitted in ITR-4.",
    options: ["Yes", "No", "Not sure"],
  },
];

export function interviewQuestions(sources: Source[]) {
  const qs: Array<{ code: string; prompt: string; helpText: string; options: string[] }> = [
    {
      code: "RESIDENT",
      prompt: "Were you a resident of India for the previous year (FY 2025-26)?",
      helpText: "ITR-4 can be used only by residents. RNOR and NRI filers are routed to ITR-3.",
      options: ["Yes", "No", "Not sure"],
    },
    {
      code: "DIRECTOR",
      prompt: "Were you a director in any company during the year?",
      helpText: "Directors cannot use ITR-4.",
      options: ["Yes", "No", "Not sure"],
    },
    ...ELIGIBILITY_QUESTIONS,
  ];
  if (sources.includes("PROFESSION") || sources.includes("FREELANCING")) {
    qs.push({
      code: "PERSONAL_PROFESSION",
      prompt: "You mentioned professional income. Was this income earned personally rather than through a company?",
      helpText: "A company's receipts are not reported on your ITR-4. Only income in your personal name (or a partnership that is not an LLP) belongs here.",
      options: ["Yes", "No", "Not sure"],
    });
    qs.push({
      code: "SPECIFIED_PROFESSION",
      prompt: "Is this a specified profession (legal, medical, engineering, architecture, accountancy, technical consultancy, interior decoration, or other notified profession)?",
      helpText: "Section 44ADA applies only to specified professions. Other businesses use 44AD.",
      options: ["Yes", "No", "Not sure"],
    });
  }
  if (sources.includes("BUSINESS") || sources.includes("FREELANCING")) {
    qs.push({
      code: "PRESUMPTIVE",
      prompt: "Do you want to use the presumptive scheme (6%/8% of turnover) instead of detailed books?",
      helpText: "Presumptive taxation is the ITR-4 path. Detailed P&L and balance sheet belong in ITR-3.",
      options: ["Yes", "No", "Not sure"],
    });
  }
  if (sources.includes("SALARY")) {
    qs.push({
      code: "FORM16",
      prompt: "Do you have Form 16 from your employer?",
      helpText: "Form 16 is used to fill salary and TDS. You can also type the figures from your payslips.",
      options: ["Yes", "No", "Not sure"],
    });
  }
  qs.push({
    code: "AIS",
    prompt: "Do you have your AIS or Form 26AS for this year?",
    helpText: "We use AIS/26AS only as reconciliation data. Those figures are not assumed to be correct.",
    options: ["Yes", "No", "Not sure"],
  });
  return qs;
}

export async function seedInterview(returnId: string, sources: Source[]) {
  const qs = interviewQuestions(sources);
  const existing = await prisma.question.findMany({ where: { returnId }, select: { code: true, sortOrder: true } });
  const have = new Set(existing.map((question) => question.code));
  const missing = qs.filter((question) => !have.has(question.code));
  if (!missing.length) return;
  const start = existing.reduce((max, question) => Math.max(max, question.sortOrder), -1) + 1;
  await prisma.question.createMany({
    data: missing.map((question, index) => ({
      returnId,
      code: question.code,
      prompt: question.prompt,
      helpText: question.helpText,
      optionsJson: JSON.stringify(question.options),
      sortOrder: start + index,
    })),
  });
}

export function parseOptions(raw: string | null | undefined) {
  const parsed = json<string[]>(raw, DEFAULT_OPTIONS);
  if (!Array.isArray(parsed) || parsed.length === 0) return DEFAULT_OPTIONS;
  return parsed.filter((opt) => typeof opt === "string" && opt.trim());
}
