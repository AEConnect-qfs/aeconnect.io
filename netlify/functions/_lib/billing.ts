import { prisma } from './prisma.js';
import { PRICING, centsToUSD, type Plan } from './pricing.js';

/**
 * Server-side billing enforcement (spec §2, do-not-lose #1–3). The trial gate is
 * anchored to the user record; metering is per-user per-billing-month; the gate
 * is checked BEFORE any Claude call so we never incur AI cost for an unbillable
 * request.
 */
export class BillingBlocked extends Error {
  code = 'TRIAL_EXHAUSTED' as const;
  constructor(message: string) {
    super(message);
    this.name = 'BillingBlocked';
  }
}

export function currentBillingMonth(d = new Date()): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

interface MeterableCase {
  id: string;
  firstAssessedAt: Date | null;
}

/** Gate check — call BEFORE the Claude call. Re-runs of an assessed case are free. */
export async function assertCanProcessCase(
  userId: string,
  c: MeterableCase,
): Promise<{ shouldMeter: boolean }> {
  if (c.firstAssessedAt) return { shouldMeter: false };

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { plan: true, trialCasesUsed: true },
  });
  if (!user) throw new BillingBlocked('Account not found');

  if ((user.plan as Plan) === 'trial' && user.trialCasesUsed >= PRICING.trialCases) {
    throw new BillingBlocked(
      `Free trial used up (${PRICING.trialCases} cases). Subscribe to Core to keep processing.`,
    );
  }
  return { shouldMeter: true };
}

/** Record a processed case. Idempotent per case via the firstAssessedAt claim. */
export async function recordCaseProcessed(userId: string, c: MeterableCase): Promise<void> {
  if (c.firstAssessedAt) return;
  const month = currentBillingMonth();

  await prisma.$transaction(async (tx) => {
    const claim = await tx.case.updateMany({
      where: { id: c.id, firstAssessedAt: null },
      data: { firstAssessedAt: new Date() },
    });
    if (claim.count === 0) return;

    const user = await tx.user.findUnique({
      where: { id: userId },
      select: { plan: true },
    });
    if (!user) return;

    if ((user.plan as Plan) === 'trial') {
      await tx.user.update({ where: { id: userId }, data: { trialCasesUsed: { increment: 1 } } });
    }

    const usage = await tx.billingUsage.upsert({
      where: { userId_billingMonth: { userId, billingMonth: month } },
      create: { userId, billingMonth: month, casesProcessed: 1 },
      update: { casesProcessed: { increment: 1 } },
    });

    // Overage is counted only. Checkout is a flat $20 subscription, so amountDueCents
    // is not increased and the usage API does not present a per-case charge.
    if ((user.plan as Plan) === 'core' && usage.casesProcessed > PRICING.includedCasesPerMonth) {
      await tx.billingUsage.update({
        where: { userId_billingMonth: { userId, billingMonth: month } },
        data: { overageCases: { increment: 1 } },
      });
    }
  });
}

export async function getUsage(userId: string) {
  const month = currentBillingMonth();
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { plan: true, trialCasesUsed: true },
  });
  if (!user) throw new Error('Account not found');

  const usage = await prisma.billingUsage.findUnique({
    where: { userId_billingMonth: { userId, billingMonth: month } },
  });
  const plan = user.plan as Plan;
  const casesProcessed = usage?.casesProcessed ?? 0;
  const overageCases = usage?.overageCases ?? 0;
  const estimatedAmountDueCents = plan === 'core' ? PRICING.coreMonthlyCents : 0;

  return {
    plan,
    billingMonth: month,
    trial:
      plan === 'trial'
        ? {
            limit: PRICING.trialCases,
            used: user.trialCasesUsed,
            remaining: Math.max(0, PRICING.trialCases - user.trialCasesUsed),
          }
        : null,
    casesProcessed,
    includedPerMonth: PRICING.includedCasesPerMonth,
    overageCases,
    overageBilled: false,
    monthlyBaseCents: PRICING.coreMonthlyCents,
    estimatedAmountDueCents,
    estimatedAmountDue: centsToUSD(estimatedAmountDueCents),
  };
}

export async function subscribeToCore(userId: string): Promise<void> {
  await prisma.user.update({
    where: { id: userId },
    data: { plan: 'core', subscribedAt: new Date() },
  });
}
