// Tests for vendor-remediation guards: account equality + stale-guard filter.
// Run: npx tsx scripts/test-vendor-remediation.ts
import { sameAccount } from "@/lib/vendor-remediation";

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => { if (c) pass++; else { fail++; console.log("  FAIL:", m); } };

// exact + case/dash tolerance
ok(sameAccount("Fuel – Overhead", "Fuel - Overhead"), "en-dash vs hyphen match");
ok(sameAccount("Meals (50% deductible)", "meals (50% deductible)"), "case-insensitive");
// leaf tolerance: QBO returns fully-qualified sub-account paths
ok(sameAccount("Vehicle Expenses:Tolls", "Tolls"), "parent:child matches leaf");
ok(sameAccount("Tolls", "Vehicle Expenses:Tolls"), "leaf matches parent:child (symmetric)");
// non-matches
ok(!sameAccount("Job Supplies & Materials", "Office Supplies"), "different accounts differ");
ok(!sameAccount("", "Tolls"), "empty never matches");
ok(!sameAccount("Vehicle Expenses:Tolls", "Vehicle Expenses:Fuel – Overhead"), "sibling sub-accounts differ");

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
