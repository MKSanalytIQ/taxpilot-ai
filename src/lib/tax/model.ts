export type TaxRegime = "NEW" | "OLD";

export type CapitalGainLine = {
  kind: string;
  section: string;
  amount: number;
  assetType?: string;
  identifier?: string;
  acquisitionDate?: string;
  saleDate?: string;
  saleConsideration?: number;
  acquisitionCost?: number;
  improvementCost?: number;
  transferExpenses?: number;
  holdingPeriodDays?: number;
  specialRate?: number;
};

export type NormalizedReturn = {
  assessmentYear: string;
  itrType: "ITR-4" | "ITR-3" | "UNDETERMINED";
  taxpayerType: "INDIVIDUAL" | "HUF" | "FIRM";
  residentialStatus: "RESIDENT" | "RNOR" | "NRI" | "";
  pan: string;
  name: string;
  firstName?: string;
  lastName?: string;
  fatherName?: string;
  email?: string;
  phone?: string;
  dateOfBirth?: string;
  gender?: string;
  addressLine1?: string;
  locality?: string;
  city?: string;
  state?: string;
  stateCode?: string;
  pincode?: string;
  employerCategory?: string;
  verificationPlace?: string;
  regime: TaxRegime;
  salary: {
    gross: number;
    exemptions: number;
    tds: number;
    employerName: string;
    employerTan: string;
  };
  business: {
    section: "44AD" | "44AE" | "BOOKS";
    turnover: number;
    digitalReceipts: number;
    cashReceipts: number;
    declaredIncome: number;
    nature: string;
    natureCode?: string;
  };
  profession: {
    section: "44ADA" | "BOOKS";
    grossReceipts: number;
    cashReceipts: number;
    declaredIncome: number;
    profession: string;
    natureCode?: string;
  };
  houseProperties: Array<{
    occupancy: "SELF_OCCUPIED" | "LET_OUT";
    annualLetableValue: number;
    municipalTaxes: number;
    interestOnLoan: number;
    address?: string;
    city?: string;
    pincode?: string;
    stateCode?: string;
  }>;
  otherIncome: Array<{ kind: string; amount: number; source: string }>;
  capitalGains: CapitalGainLine[];
  deductions: Array<{
    section: string;
    amount: number;
    beneficiary?: "SELF_FAMILY" | "PARENTS";
    kind?: "PREMIUM" | "PREVENTIVE" | "MEDICAL";
    senior?: boolean;
  }>;
  tds: Array<{
    sectionCode: string;
    tan: string;
    amount: number;
    deductorName: string;
    grossAmount?: number;
    kind?: string;
  }>;
  taxPayments: Array<{ kind: "ADVANCE" | "SELF_ASSESSMENT" | "REGULAR"; amount: number; paidOn?: string }>;
  bankAccounts: Array<{
    ifsc: string;
    accountNumber: string;
    isPrimary: boolean;
    bankName?: string;
    accountType?: string;
  }>;
  /** Income-source codes the taxpayer selected. Absence is unknown, not a denial. */
  incomeSources?: string[];
  /** Explicit answers. A missing key is unknown and must not be treated as false or zero. */
  eligibilityConfirmed?: {
    lotteryOrRacehorse?: boolean;
    foreignAssets?: boolean;
    unlistedShares?: boolean;
    fnoTrading?: boolean;
    isDirector?: boolean;
    isLlp?: boolean;
    agriculturalIncome?: number;
  };
};
