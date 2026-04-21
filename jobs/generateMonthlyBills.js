// ─────────────────────────────────────────────────────────────────────────────
// jobs/generateMonthlyBills.js
//
// All time rules:
//  - "Now" is always derived in BST (UTC+6).
//  - billingPeriodStart / billingPeriodEnd are stored as plain UTC Date objects
//    whose calendar date matches the BST month boundaries (day=1, midnight UTC).
//    They are only ever used for range comparisons on createdAt (epoch ms) and
//    for display, so storing them as UTC midnight of the BST calendar date is fine.
//  - dueDate is stored as epoch-ms = the last millisecond of the due calendar
//    day in BST, i.e.  BST 23:59:59.999  →  UTC = that ms − 6 h.
// ─────────────────────────────────────────────────────────────────────────────

const BST_OFFSET_MS = 6 * 60 * 60 * 1000; // UTC+6
const DUE_HOUR_BST = { h: 23, m: 59, s: 59, ms: 999 };

/**
 * Given a BST calendar date (year, month 1-indexed, day), return the epoch-ms
 * that corresponds to 23:59:59.999 BST on that day.
 */
function bstEndOfDay(year, month, day) {
  // Build UTC midnight of that BST calendar date, then add the time-of-day.
  const utcMidnight = Date.UTC(year, month - 1, day); // midnight UTC = 06:00 BST
  // We want 23:59:59.999 BST = 23:59:59.999 - 6h in UTC
  return (
    utcMidnight -
    BST_OFFSET_MS + // shift: UTC midnight → BST midnight
    DUE_HOUR_BST.h * 3_600_000 +
    DUE_HOUR_BST.m * 60_000 +
    DUE_HOUR_BST.s * 1_000 +
    DUE_HOUR_BST.ms
  );
}

/**
 * Return the BST calendar { year, month (1-indexed), day } for a given epoch-ms.
 */
function toBstDate(epochMs) {
  const d = new Date(epochMs + BST_OFFSET_MS);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
  };
}

/**
 * Compute the due-date epoch-ms.
 *
 * Strategy: take "now" in BST, add DUE_DAYS calendar days, then snap to
 * 23:59:59.999 BST of that day.
 * e.g. cron fires 2026-01-01 00:05 BST, DUE_DAYS=7 → due = 2026-01-08 23:59:59.999 BST
 */
function computeDueDate(nowUtcMs, dueDays) {
  const bst = toBstDate(nowUtcMs);
  // Add dueDays to the BST calendar day.
  // Use Date arithmetic on a UTC date that represents the BST calendar date.
  const bstCalendarMs = Date.UTC(bst.year, bst.month - 1, bst.day);
  const targetMs = bstCalendarMs + dueDays * 24 * 60 * 60 * 1000;
  const target = new Date(targetMs);
  return bstEndOfDay(target.getUTCFullYear(), target.getUTCMonth() + 1, target.getUTCDate());
}

// ─────────────────────────────────────────────────────────────────────────────

export async function generateMonthlyBills(db, options = {}) {
  const DUE_DAYS = parseInt(process.env.BILLING_DUE_DAYS) || 7;
  const nowUtc = Date.now();

  // ── Determine billing period ────────────────────────────────────────────
  let y, m; // BST calendar year + month (1-indexed) for the period to bill

  if (options.year && options.month) {
    y = options.year;
    m = options.month; // caller already validated this is a past month
  } else {
    // Automatic: bill for the month that just ended in BST.
    // Cron fires at 00:05 BST on the 1st → BST month is the NEW month,
    // so "previous month" = new month − 1.
    const bst = toBstDate(nowUtc);
    y = bst.year;
    m = bst.month - 1; // previous month
    if (m === 0) {
      m = 12;
      y -= 1;
    }
  }

  // Period boundaries stored as UTC Date objects whose UTC calendar values
  // match the BST month (adequate for invoice createdAt range queries).
  const periodStart = new Date(Date.UTC(y, m - 1, 1)); // first ms of the month
  const periodEnd = new Date(Date.UTC(y, m, 1)); // first ms of next month (exclusive)
  const periodEndDisplay = new Date(Date.UTC(y, m, 0)); // last day of the month

  // Due date: DUE_DAYS calendar days from "now" in BST, snapped to 23:59:59.999 BST.
  // For manual runs a custom dueDate can be supplied (already a valid epoch-ms).
  const dueDate = options.dueDate != null ? options.dueDate : computeDueDate(nowUtc, DUE_DAYS);

  const triggeredBy = options.triggeredBy || "cron";

  // ── Load all active labs ────────────────────────────────────────────────
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
      // Idempotency guard
      const exists = await db
        .collection("billings")
        .findOne({ labId: lab._id, billingPeriodStart: periodStart }, { projection: { _id: 1 } });
      if (exists) {
        skipped++;
        continue;
      }

      const monthlyFee = lab.billing?.monthlyFee ?? 0;
      const perInvoiceFee = lab.billing?.perInvoiceFee ?? 0;
      const commission = lab.billing?.commission ?? 0;

      const invoiceCount = await db.collection("invoices").countDocuments({
        labId: lab._id,
        "deletion.status": { $ne: true },
        createdAt: {
          $gte: periodStart.getTime(),
          $lt: periodEnd.getTime(),
        },
      });

      const perInvoiceNet = perInvoiceFee - commission;
      const totalAmount = monthlyFee + perInvoiceNet * invoiceCount;
      const isFree = totalAmount <= 0;

      await db.collection("billings").insertOne({
        labId: lab._id,
        labKey: lab.labKey,
        billingPeriodStart: periodStart,
        billingPeriodEnd: periodEndDisplay,
        invoiceCount,
        breakdown: { monthlyFee, perInvoiceFee, commission, perInvoiceNet },
        totalAmount: isFree ? 0 : totalAmount,
        status: isFree ? "free" : "unpaid",
        dueDate: isFree ? null : dueDate,
        createdAt: nowUtc,
        paidAt: null,
        paidBy: null,
      });

      isFree ? free++ : generated++;
    } catch (err) {
      failedLabs.push({
        labId: lab._id,
        labName: lab.name ?? "Unknown",
        error: err.message,
      });
    }
  }

  const runDoc = {
    period: `${y}-${String(m).padStart(2, "0")}`,
    periodStart,
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
    JSON.stringify({
      period: runDoc.period,
      generated,
      free,
      skipped,
      failedCount: failedLabs.length,
    }),
  );

  return runDoc;
}

// ─────────────────────────────────────────────────────────────────────────────

export async function retryFailedLabs(db, run) {
  const DUE_DAYS = parseInt(process.env.BILLING_DUE_DAYS) || 7;
  const nowUtc = Date.now();

  const periodStart = run.periodStart;
  const periodEnd = new Date(Date.UTC(periodStart.getUTCFullYear(), periodStart.getUTCMonth() + 1, 1));
  const periodEndDisplay = new Date(Date.UTC(periodStart.getUTCFullYear(), periodStart.getUTCMonth() + 1, 0));

  // Re-use the same due date from the original run if we can find any bill,
  // otherwise compute a fresh one.
  const existingBill = await db
    .collection("billings")
    .findOne({ billingPeriodStart: periodStart, status: "unpaid" }, { projection: { dueDate: 1 } });
  const dueDate = existingBill?.dueDate != null ? existingBill.dueDate : computeDueDate(nowUtc, DUE_DAYS);

  const retried = [];
  const stillFailing = [];

  for (const failed of run.failedLabs) {
    try {
      const exists = await db
        .collection("billings")
        .findOne({ labId: failed.labId, billingPeriodStart: periodStart }, { projection: { _id: 1 } });
      if (exists) {
        retried.push({ labId: failed.labId, result: "already existed" });
        continue;
      }

      const lab = await db
        .collection("labs")
        .findOne(
          { _id: failed.labId, "deletion.status": { $ne: true } },
          { projection: { _id: 1, name: 1, labKey: 1, billing: 1 } },
        );

      if (!lab) {
        stillFailing.push({ labId: failed.labId, error: "Lab not found" });
        continue;
      }

      const monthlyFee = lab.billing?.monthlyFee ?? 0;
      const perInvoiceFee = lab.billing?.perInvoiceFee ?? 0;
      const commission = lab.billing?.commission ?? 0;

      const invoiceCount = await db.collection("invoices").countDocuments({
        labId: lab._id,
        "deletion.status": { $ne: true },
        createdAt: {
          $gte: periodStart.getTime(),
          $lt: periodEnd.getTime(),
        },
      });

      const perInvoiceNet = perInvoiceFee - commission;
      const totalAmount = monthlyFee + perInvoiceNet * invoiceCount;
      const isFree = totalAmount <= 0;

      await db.collection("billings").insertOne({
        labId: lab._id,
        labKey: lab.labKey,
        billingPeriodStart: periodStart,
        billingPeriodEnd: periodEndDisplay,
        invoiceCount,
        breakdown: { monthlyFee, perInvoiceFee, commission, perInvoiceNet },
        totalAmount: isFree ? 0 : totalAmount,
        status: isFree ? "free" : "unpaid",
        dueDate: isFree ? null : dueDate,
        createdAt: nowUtc,
        paidAt: null,
        paidBy: null,
      });

      retried.push({ labId: failed.labId, labName: lab.name, result: "success" });
    } catch (err) {
      stillFailing.push({
        labId: failed.labId,
        labName: failed.labName,
        error: err.message,
      });
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
    JSON.stringify({
      period: run.period,
      retried: retried.length,
      stillFailing: stillFailing.length,
    }),
  );

  return { retried, stillFailing };
}
