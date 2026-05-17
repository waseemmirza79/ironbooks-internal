/**
 * QBO Validation Rules
 * --------------------
 * Production safeguards before sending anything to QBO.
 *
 * QBO returns vague "Request has invalid or unsupported property" errors
 * for many invalid inputs. We pre-validate against QBO's actual enum spec
 * so we never blindly submit something we know will fail.
 *
 * Source of truth:
 *  - AccountType enum: https://static.developer.intuit.com/sdkdocs/qbv3doc/ipp-v3-java-devkit-javadoc/com/intuit/ipp/data/AccountTypeEnum.html
 *  - AccountSubType enum: documented per AccountType in QBO API reference
 *
 * If QBO adds a new subtype later, add it here. Validation is intentionally
 * strict — better to flag for review than to fail at runtime.
 */

// ============== ACCOUNT TYPE ENUM ==============
// Exact strings QBO accepts for AccountType. Anything else → reject.
export const VALID_ACCOUNT_TYPES = new Set([
  'Bank',
  'Accounts Receivable',
  'Other Current Asset',
  'Fixed Asset',
  'Other Asset',
  'Accounts Payable',
  'Credit Card',
  'Other Current Liability',
  'Long Term Liability',
  'Equity',
  'Income',
  'Cost of Goods Sold',
  'Expense',
  'Other Income',
  'Other Expense',
  'Non-Posting',
]);

// ============== ACCOUNT SUBTYPE → TYPE MAPPING ==============
// Each subtype is valid for exactly one type. If we receive a subtype that
// doesn't belong to the declared type, the request will 2010/2170 from QBO.
//
// This list is the QBO documented spec. NOT every subtype is listed if it's
// rarely used; we err on the side of including common ones used in COA cleanups.
//
// If we don't recognize a subtype, that's a sign of:
//   (a) bad data in master_coa (e.g., "SubcontractorCosts" isn't in QBO's enum)
//   (b) the AI inventing a subtype name
// Either way → flag for manual review, don't submit.
export const SUBTYPE_TO_TYPE: Record<string, string> = {
  // Bank
  CashOnHand: 'Bank',
  Checking: 'Bank',
  MoneyMarket: 'Bank',
  RentsHeldInTrust: 'Bank',
  Savings: 'Bank',
  TrustAccounts: 'Bank',

  // Accounts Receivable
  AccountsReceivable: 'Accounts Receivable',

  // Other Current Asset
  AllowanceForBadDebts: 'Other Current Asset',
  DevelopmentCosts: 'Other Current Asset',
  EmployeeCashAdvances: 'Other Current Asset',
  Inventory: 'Other Current Asset',
  InvestmentMortgageRealEstateLoans: 'Other Current Asset',
  InvestmentOther: 'Other Current Asset',
  InvestmentTaxExemptSecurities: 'Other Current Asset',
  InvestmentUSGovernmentObligations: 'Other Current Asset',
  LoansToOfficers: 'Other Current Asset',
  LoansToOthers: 'Other Current Asset',
  LoansToStockholders: 'Other Current Asset',
  OtherCurrentAssets: 'Other Current Asset',
  PrepaidExpenses: 'Other Current Asset',
  Retainage: 'Other Current Asset',
  UndepositedFunds: 'Other Current Asset',
  AssetsAvailableForSale: 'Other Current Asset',

  // Fixed Asset
  AccumulatedDepletion: 'Fixed Asset',
  AccumulatedDepreciation: 'Fixed Asset',
  AccumulatedAmortization: 'Fixed Asset',
  Buildings: 'Fixed Asset',
  DepletableAssets: 'Fixed Asset',
  FixedAssetComputers: 'Fixed Asset',
  FixedAssetCopiers: 'Fixed Asset',
  FixedAssetFurniture: 'Fixed Asset',
  FixedAssetPhone: 'Fixed Asset',
  FixedAssetPhotoVideo: 'Fixed Asset',
  FixedAssetSoftware: 'Fixed Asset',
  FixedAssetOtherToolsEquipment: 'Fixed Asset',
  FurnitureAndFixtures: 'Fixed Asset',
  IntangibleAssets: 'Fixed Asset',
  LandAsset: 'Fixed Asset',
  LeaseholdImprovements: 'Fixed Asset',
  OtherFixedAssets: 'Fixed Asset',
  MachineryAndEquipment: 'Fixed Asset',
  Vehicles: 'Fixed Asset',
  AssetsInProduction: 'Fixed Asset',

  // Other Asset
  LeaseBuyout: 'Other Asset',
  OtherLongTermAssets: 'Other Asset',
  SecurityDeposits: 'Other Asset',
  AccumulatedAmortizationOfOtherAssets: 'Other Asset',
  Goodwill: 'Other Asset',
  Licenses: 'Other Asset',
  OrganizationalCosts: 'Other Asset',
  AssetsHeldForSale: 'Other Asset',
  AvailableForSaleFinancialAssets: 'Other Asset',

  // Accounts Payable
  AccountsPayable: 'Accounts Payable',

  // Credit Card
  CreditCard: 'Credit Card',

  // Other Current Liability
  DirectDepositPayable: 'Other Current Liability',
  LineOfCredit: 'Other Current Liability',
  LoanPayable: 'Other Current Liability',
  GlobalTaxPayable: 'Other Current Liability',
  GlobalTaxSuspense: 'Other Current Liability',
  OtherCurrentLiabilities: 'Other Current Liability',
  PayrollClearing: 'Other Current Liability',
  PayrollTaxPayable: 'Other Current Liability',
  PrepaidExpensesPayable: 'Other Current Liability',
  RentsInTrustLiability: 'Other Current Liability',
  TrustAccountsLiabilities: 'Other Current Liability',
  FederalIncomeTaxPayable: 'Other Current Liability',
  InsurancePayable: 'Other Current Liability',
  SalesTaxPayable: 'Other Current Liability',
  StateLocalIncomeTaxPayable: 'Other Current Liability',

  // Long Term Liability
  NotesPayable: 'Long Term Liability',
  OtherLongTermLiabilities: 'Long Term Liability',
  ShareholderNotesPayable: 'Long Term Liability',

  // Equity
  OpeningBalanceEquity: 'Equity',
  PartnersEquity: 'Equity',
  RetainedEarnings: 'Equity',
  AccumulatedAdjustment: 'Equity',
  OwnersEquity: 'Equity',
  PaidInCapitalOrSurplus: 'Equity',
  PartnerContributions: 'Equity',
  PartnerDistributions: 'Equity',
  PreferredStock: 'Equity',
  CommonStock: 'Equity',
  TreasuryStock: 'Equity',
  EstimatedTaxes: 'Equity',
  Healthcare: 'Equity',
  PersonalIncome: 'Equity',
  PersonalExpense: 'Equity',

  // Income
  NonProfitIncome: 'Income',
  OtherPrimaryIncome: 'Income',
  SalesOfProductIncome: 'Income',
  ServiceFeeIncome: 'Income',
  DiscountsRefundsGiven: 'Income',
  UnappliedCashPaymentIncome: 'Income',
  CashReceiptIncome: 'Income',
  OperatingGrants: 'Income',
  OtherCurrentOperatingIncome: 'Income',
  OwnTransferOfIncome: 'Income',
  RevenueGeneral: 'Income',
  SalesRetail: 'Income',
  SalesWholesale: 'Income',
  SavingsByTaxScheme: 'Income',

  // Cost of Goods Sold
  EquipmentRentalCos: 'Cost of Goods Sold',
  OtherCostsOfServiceCos: 'Cost of Goods Sold',
  ShippingFreightDeliveryCos: 'Cost of Goods Sold',
  SuppliesMaterialsCogs: 'Cost of Goods Sold',
  CostOfLabor: 'Cost of Goods Sold',
  CostOfLaborCos: 'Cost of Goods Sold',

  // Expense
  AdvertisingPromotional: 'Expense',
  BadDebts: 'Expense',
  BankCharges: 'Expense',
  CharitableContributions: 'Expense',
  CommissionsAndFees: 'Expense',
  Entertainment: 'Expense',
  EntertainmentMeals: 'Expense',
  EquipmentRental: 'Expense',
  FinanceCosts: 'Expense',
  GlobalTaxExpense: 'Expense',
  Insurance: 'Expense',
  InterestPaid: 'Expense',
  LegalProfessionalFees: 'Expense',
  OfficeExpenses: 'Expense',
  OfficeGeneralAdministrativeExpenses: 'Expense',
  PromotionalMeals: 'Expense',
  RentOrLeaseOfBuildings: 'Expense',
  RepairMaintenance: 'Expense',
  ShippingFreightDelivery: 'Expense',
  SuppliesMaterials: 'Expense',
  Travel: 'Expense',
  TravelMeals: 'Expense',
  Utilities: 'Expense',
  Auto: 'Expense',
  CostOfLaborExpense: 'Expense',
  DuesSubscriptions: 'Expense',
  PayrollExpenses: 'Expense',
  TaxesPaid: 'Expense',
  UnappliedCashBillPaymentExpense: 'Expense',
  Utilities2: 'Expense',
  ManagementCompensation: 'Expense',
  IncomeTaxExpense: 'Expense',
  PenaltiesSettlements: 'Expense',
  Amortization: 'Expense',
  DistributionCosts: 'Expense',
  ExternalServices: 'Expense',
  Communications: 'Expense',

  // Other Income
  DividendIncome: 'Other Income',
  InterestEarned: 'Other Income',
  OtherInvestmentIncome: 'Other Income',
  OtherMiscellaneousIncome: 'Other Income',
  TaxExemptInterest: 'Other Income',
  GainLossOnSaleOfFixedAssets: 'Other Income',
  GainLossOnSaleOfInvestments: 'Other Income',
  LossOnDisposalOfAssets: 'Other Income',

  // Other Expense
  Depreciation: 'Other Expense',
  ExchangeGainOrLoss: 'Other Expense',
  OtherMiscellaneousExpense: 'Other Expense',
  PenaltiesAndFees: 'Other Expense',
  AmortizationExpense: 'Other Expense',
  HomeOffice: 'Other Expense',
  HomeOwnersRentalInsurance: 'Other Expense',
  OtherHomeOwnerExpenses: 'Other Expense',
  ResearchAndDevelopment: 'Other Expense',
  RentAndLeaseOfBuildings: 'Other Expense',
  UtilitiesOtherExpense: 'Other Expense',
  MortgageInterest: 'Other Expense',
};

// Reverse: for a given AccountType, what subtypes are valid?
export const TYPE_TO_VALID_SUBTYPES = (() => {
  const m: Record<string, Set<string>> = {};
  for (const [subtype, type] of Object.entries(SUBTYPE_TO_TYPE)) {
    if (!m[type]) m[type] = new Set();
    m[type].add(subtype);
  }
  return m;
})();

// ============== SYSTEM ACCOUNTS QBO BLOCKS ==============
// These are QBO platform-protected. ANY attempt to inactivate or modify them
// via API returns 2010 "invalid property". They must be skipped, not retried.
// Detection is by exact name match (case-insensitive) since QBO doesn't expose
// a "system account" flag on the API response.
const SYSTEM_ACCOUNT_NAME_PATTERNS: RegExp[] = [
  /^Uncategorized\s+(Asset|Expense|Income)$/i,
  /^Opening\s+Balance\s+Equity$/i,
  /^Retained\s+Earnings$/i,
  /^Undeposited\s+Funds$/i,
  /^Accounts\s+(Payable|Receivable)$/i, // The default system A/P, A/R
  /^Sales\s+Tax\s+Payable$/i,
  /^Inventory\s+Asset$/i,
  /^Sales\s+of\s+Product\s+Income$/i, // Cannot inactivate this one in QBO sandbox
  /^Cost\s+of\s+Goods\s+Sold$/i, // The system default COGS account
  /^Unapplied\s+Cash\s+(Bill\s+Payment\s+Expense|Payment\s+Income)$/i,
  /^Reconciliation\s+Discrepancies$/i,
  /^Exchange\s+Gain\s+or\s+Loss$/i,
  /^Billable\s+Expense\s+Income$/i,
  // QBO assigns these as defaults for products/services and shipping lines.
  // Inactivation via API returns code 6000 ("can't be deleted because it
  // is used by..."). Treat as system-protected — must be reassigned in QBO
  // UI under Account & Settings → Sales / Products before removal.
  /^Ask\s+My\s+Accountant$/i,
  /^Shipping\s+Income$/i,
  /^Discounts\s+Given$/i,
  /^Refunds-?Allowances$/i,
];

export function isSystemAccount(name: string | null | undefined): boolean {
  if (!name) return false;
  return SYSTEM_ACCOUNT_NAME_PATTERNS.some((rx) => rx.test(name.trim()));
}

// ============== VALIDATION RESULT ==============

export type ValidationResult =
  | { ok: true; correctedType?: string; correctedSubType?: string }
  | { ok: false; reason: string; suggestion?: string };

/**
 * Validate an AccountType + AccountSubType combination.
 * If the combo is valid, returns { ok: true }.
 * If we can auto-correct (e.g., the type is wrong but the subtype is recognized),
 * returns { ok: true, correctedType }.
 * Otherwise returns { ok: false, reason }.
 */
export function validateTypeSubtype(
  type: string | null | undefined,
  subtype: string | null | undefined
): ValidationResult {
  if (!type && !subtype) {
    return { ok: false, reason: 'Both AccountType and AccountSubType are missing' };
  }
  if (!subtype) {
    return { ok: false, reason: 'AccountSubType is missing' };
  }
  if (!SUBTYPE_TO_TYPE[subtype]) {
    return {
      ok: false,
      reason: `AccountSubType "${subtype}" is not a valid QBO enum value`,
      suggestion: suggestSimilarSubtype(subtype),
    };
  }
  const expectedType = SUBTYPE_TO_TYPE[subtype];
  if (!type) {
    return { ok: true, correctedType: expectedType };
  }
  if (!VALID_ACCOUNT_TYPES.has(type)) {
    return {
      ok: false,
      reason: `AccountType "${type}" is not a valid QBO enum value`,
    };
  }
  if (type !== expectedType) {
    // Subtype is recognized but doesn't belong to the declared type.
    // Trust the subtype and auto-correct the type — subtype is more specific.
    return { ok: true, correctedType: expectedType };
  }
  return { ok: true };
}

/**
 * Best-effort fuzzy match to suggest a real QBO subtype when the data has
 * an invented or close-but-wrong name (e.g., "SubcontractorCosts" → "OtherCostsOfServiceCos").
 */
function suggestSimilarSubtype(invalid: string): string | undefined {
  const lower = invalid.toLowerCase();
  // Hardcoded common AI mistakes
  const aliases: Record<string, string> = {
    subcontractorcosts: 'OtherCostsOfServiceCos',
    subcontractor: 'OtherCostsOfServiceCos',
    materialcosts: 'SuppliesMaterialsCogs',
    materialscosts: 'SuppliesMaterialsCogs',
    paintcosts: 'SuppliesMaterialsCogs',
    laborcosts: 'CostOfLabor',
  };
  if (aliases[lower]) return aliases[lower];
  return undefined;
}

/**
 * Determine if a rename would create a name collision with an existing account.
 * QBO requires unique names within the same parent (or top-level).
 */
export function wouldCollide(
  newName: string,
  existingAccounts: Array<{ Id: string; Name: string; ParentRef?: { value: string }; Active?: boolean }>,
  selfId: string,
  parentId: string | null
): boolean {
  return existingAccounts.some((a) =>
    a.Id !== selfId &&
    a.Active !== false &&
    a.Name.trim().toLowerCase() === newName.trim().toLowerCase() &&
    (a.ParentRef?.value || null) === parentId
  );
}
