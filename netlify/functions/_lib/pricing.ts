/**
 * AE Connect — LOCKED pricing (spec §2). SINGLE SOURCE OF TRUTH.
 * Every billing calculation reads from here so a price change is one edit.
 */
export const PRICING = {
  trialCases: 5, // first 5 AI-processed cases free, no card
  coreMonthlyCents: 2000, // $20 / month
  includedCasesPerMonth: 25, // cases included in Core
  // Historical per-case figure. Not collected: Core Checkout is a flat monthly price.
  overagePerCaseCents: 100,
} as const;

export type Plan = 'trial' | 'core';

export function centsToUSD(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}
