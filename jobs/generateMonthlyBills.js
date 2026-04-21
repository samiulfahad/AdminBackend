// ── jobs/generateMonthlyBills.js ─────────────────────────────────────────────
//
// Bill generation rules:
//  - Bills are POSTPAID: April's bill is generated on May 1st (BST) at 00:05.
//  - Period boundaries are stored as UTC ms (startOfMonthBST / endOfMonthBST).
//  - dueDate is always 23:59:59.999 BST of the Nth day after generation.
//  - Idempotent: re-running for the same period skips existing bills.
//  - December→January: handled automatically by month arithmetic.

import { nowBST, endOfDayBST, startOfMonthBST, endOfMonthBST } from "../utils/time.js";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function getPreviousMonth(bstNow) {
  let year = bstNow.year;
  let month = bstNow.month - 1; // previous month
  if (month === 0) {
    month = 12;
    year -= 1;
  }
  return { year, month };
}

function buildBillingDoc(lab, { periodStartMs, periodEndMs, invoiceCount, dueDate, nowUtc }) {
  const monthlyFee = lab.billing?.monthlyFee ?? 0;
  const perInvoiceFee = lab.billing?.perInvoiceFee ?? 0;
  const commission = lab.billing?.commission ?? 0;
  const perInvoiceNet = perInvoiceFee - commission;
  const totalAmount = monthlyFee + perInvoiceNet * invoiceCount;
  const isFree = totalAmount <= 0;

  return {
    labId: lab._id,
    labKey: lab.labKey,
    // Store as UTC ms — consistent with createdAt, paidAt, etc.
    billingPeriodStart: periodStartMs,
    billingPeriodEnd: periodEndMs,
    invoiceCount,
    breakdown: {
      monthlyFee,
      perInvoiceFee,
      commission,
      perInvoiceNet,
    },
    totalAmount: isFree ? 0 : totalAmount,
    status: isFree ? "free" : "unpaid",
    // dueDate is 23:59:59.999 BST of the due day, stored as UTC ms.
    // Free bills have no due date.
    dueDate: isFree ? null : dueDate,
    createdAt: nowUtc,
    paidAt: null,
    paidBy: null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Main export
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generates monthly bills for all active labs.
 *
 * @param {import('mongodb').Db} db
 * @param {object} options
 * @param {number} [options.year]         - BST year  (manual trigger)
 * @param {number} [options.month]        - BST month, 1-indexed (manual trigger)
 * @param {string} [options.triggeredBy]  - "cron" | "manual"
 * @param {number} [options.dueDateMs]    - Override due date UTC ms (manual trigger only)
 */
export async function generateMonthlyBills(db, options = {}) {
  const DUE_DAYS = parseInt(process.env.BILLING_DUE_DAYS ?? "7", 10);
  const nowUtc = Date.now();
  const triggeredBy = options.triggeredBy ?? "cron";

  // ── Determine billing period ──────────────────────────────────────────────
  let year, month;

  if (options.year && options.month) {
    year = options.year;
    month = options.month; // 1-indexed BST month
  } else {
    // Automatic: bill for the previous BST month
    const bstNow = nowBST();
    ({ year, month } = getPreviousMonth(bstNow));
  }

  const periodStartMs = startOfMonthBST(year, month);
  const periodEndMs = endOfMonthBST(year, month);

  // ── Due date ──────────────────────────────────────────────────────────────
  // Manual trigger may supply an explicit due date; otherwise N days from now.
  // Always snapped to 23:59:59.999 BST of the target day.
  const dueDate =
    options.dueDateMs != null ? endOfDayBST(options.dueDateMs) : endOfDayBST(nowUtc + DUE_DAYS * 24 * 60 * 60 * 1000);

  const periodLabel = `${year}-${String(month).padStart(2, "0")}`;

  // ── Fetch all active labs ─────────────────────────────────────────────────
  const labs = await db
    .collection("labs")
    .find(
      { isActive: true, "deletion.status": { $ne: true } },
      { projection: { _id: 1, name: 1, labKey: 1, billing: 1 } },
    )
    .toArray();

  let generated = 0;
  let free = 0;
  let skipped = 0;
  const failedLabs = [];

  for (const lab of labs) {
    try {
      // Idempotency: skip if a bill for this period already exists
      const exists = await db
        .collection("billings")
        .findOne({ labId: lab._id, billingPeriodStart: periodStartMs }, { projection: { _id: 1 } });
      if (exists) {
        skipped++;
        continue;
      }

      // Count non-deleted invoices created within the BST period
      const invoiceCount = await db.collection("invoices").countDocuments({
        labId: lab._id,
        "deletion.status": { $ne: true },
        createdAt: { $gte: periodStartMs, $lte: periodEndMs },
      });

      const doc = buildBillingDoc(lab, {
        periodStartMs,
        periodEndMs,
        invoiceCount,
        dueDate,
        nowUtc,
      });

      await db.collection("billings").insertOne(doc);
      doc.status === "free" ? free++ : generated++;
    } catch (err) {
      failedLabs.push({
        labId: lab._id,
        labName: lab.name ?? "Unknown",
        error: err.message,
      });
    }
  }

  // ── Write run log ─────────────────────────────────────────────────────────
  const runDoc = {
    period: periodLabel,
    billingPeriodStart: periodStartMs,
    triggeredBy,
    triggeredAt: nowUtc,
    totalLabs: labs.length,
    generated,
    free,
    skipped,
    failedCount: failedLabs.length,
    failedLabs,
    hasErrors: failedLabs.length > 0,
  };

  await db.collection("billingRuns").insertOne(runDoc);

  console.log(
    "[billing]",
    JSON.stringify({ period: periodLabel, generated, free, skipped, failedCount: failedLabs.length }),
  );

  return runDoc;
}

// ─────────────────────────────────────────────────────────────────────────────
// Retry failed labs from a previous run
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {import('mongodb').Db} db
 * @param {object} run  - The billingRun document
 */
export async function retryFailedLabs(db, run) {
  const DUE_DAYS = parseInt(process.env.BILLING_DUE_DAYS ?? "7", 10);
  const nowUtc = Date.now();

  const periodStartMs = run.billingPeriodStart;
  const periodEndMs = endOfMonthBSTFromStartMs(periodStartMs);
  const dueDate = endOfDayBST(nowUtc + DUE_DAYS * 24 * 60 * 60 * 1000);

  const retried = [];
  const stillFailing = [];

  for (const failed of run.failedLabs) {
    try {
      const exists = await db
        .collection("billings")
        .findOne({ labId: failed.labId, billingPeriodStart: periodStartMs }, { projection: { _id: 1 } });
      if (exists) {
        retried.push({ labId: failed.labId, result: "already existed" });
        continue;
      }

      const lab = await db
        .collection("labs")
        .findOne(
          { _id: failed.labId, isActive: true, "deletion.status": { $ne: true } },
          { projection: { _id: 1, name: 1, labKey: 1, billing: 1 } },
        );

      if (!lab) {
        stillFailing.push({ labId: failed.labId, labName: failed.labName, error: "Lab not found or inactive" });
        continue;
      }

      const invoiceCount = await db.collection("invoices").countDocuments({
        labId: lab._id,
        "deletion.status": { $ne: true },
        createdAt: { $gte: periodStartMs, $lte: periodEndMs },
      });

      const doc = buildBillingDoc(lab, { periodStartMs, periodEndMs, invoiceCount, dueDate, nowUtc });
      await db.collection("billings").insertOne(doc);

      retried.push({ labId: lab._id, labName: lab.name, result: "success" });
    } catch (err) {
      stillFailing.push({ labId: failed.labId, labName: failed.labName, error: err.message });
    }
  }

  await db.collection("billingRuns").updateOne(
    { _id: run._id },
    {
      $set: {
        failedLabs: stillFailing,
        failedCount: stillFailing.length,
        hasErrors: stillFailing.length > 0,
        lastRetryAt: nowUtc,
        retryResult: { retried, stillFailing },
      },
    },
  );

  console.log(
    "[billing-retry]",
    JSON.stringify({ period: run.period, retried: retried.length, stillFailing: stillFailing.length }),
  );

  return { retried, stillFailing };
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal helper: derive period end from period start (stored as UTC ms)
// ─────────────────────────────────────────────────────────────────────────────
function endOfMonthBSTFromStartMs(startMs) {
  // Shift start to BST to read year/month
  const bstMs = startMs + 6 * 60 * 60 * 1000;
  const d = new Date(bstMs);
  return endOfMonthBST(d.getUTCFullYear(), d.getUTCMonth() + 1);
}
