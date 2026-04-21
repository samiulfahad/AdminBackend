// ── jobs/generateMonthlyBills.js ─────────────────────────────────────────────
//
// All dates stored as UTC milliseconds in MongoDB.
// "BST" here means Bangladesh Standard Time = UTC+6 (Asia/Dhaka).
//
// Key rules:
//  • periodStart / periodEnd are UTC Date objects representing midnight UTC on
//    the 1st of the billing month (pure calendar boundaries, no timezone offset
//    needed because invoice.createdAt is already UTC ms).
//  • dueDate is stored as UTC ms but always snapped to 23:59:59.999 BST of the
//    target day  →  17:59:59.999 UTC  (BST = UTC+6, so 23:59 BST = 17:59 UTC).
//  • The cron fires at 00:05 BST on the 1st of every month.  In UTC that is
//    18:05 on the last day of the previous month  →  schedule "5 18 * * *" UTC
//    OR use { timezone: 'Asia/Dhaka' } and schedule "5 0 * * *".

const DHAKA_OFFSET_MS = 6 * 60 * 60 * 1000; // UTC+6

/**
 * Returns the UTC timestamp for 23:59:59.999 BST on the date that is
 * `daysFromNow` days after the day containing `baseUtcMs` (in BST).
 *
 * Example: baseUtcMs = now, daysFromNow = 7
 *   → end-of-day BST, 7 days from today BST.
 */
function endOfDayBST(baseUtcMs, daysFromNow = 0) {
  // Convert base to BST "calendar day"
  const bstNow = new Date(baseUtcMs + DHAKA_OFFSET_MS);
  // Advance by daysFromNow
  const targetBst = new Date(
    Date.UTC(
      bstNow.getUTCFullYear(),
      bstNow.getUTCMonth(),
      bstNow.getUTCDate() + daysFromNow,
      // 23:59:59.999 BST  =  17:59:59.999 UTC  (subtract 6 h)
      17,
      59,
      59,
      999,
    ),
  );
  return targetBst.getTime();
}

/**
 * Given "now" in UTC ms, return { y, m } (1-indexed month) for the billing
 * period = the previous calendar month in BST.
 *
 * The cron fires at 00:05 BST on the 1st, so "current BST month" is the new
 * month; we want the one before it.
 */
function previousBSTMonth(nowUtcMs) {
  const nowBst = new Date(nowUtcMs + DHAKA_OFFSET_MS);
  let y = nowBst.getUTCFullYear();
  let m = nowBst.getUTCMonth() + 1; // 1-indexed current BST month

  // Step back one month
  if (m === 1) {
    m = 12;
    y -= 1;
  } else {
    m -= 1;
  }
  return { y, m };
}

// ─────────────────────────────────────────────────────────────────────────────

export async function generateMonthlyBills(db, options = {}) {
  const DUE_DAYS = parseInt(process.env.BILLING_DUE_DAYS) || 7;
  const nowUtc = Date.now();

  // ── Determine billing period ──────────────────────────────────────────────
  let y, m; // year and 1-indexed month of the period to bill
  if (options.year && options.month) {
    y = options.year;
    m = options.month; // caller already validated this is a past month
  } else {
    ({ y, m } = previousBSTMonth(nowUtc));
  }

  // UTC midnight boundaries for the period (safe for all timezones because
  // invoice.createdAt is UTC ms, so $gte/$lt on these values is correct).
  const periodStart = new Date(Date.UTC(y, m - 1, 1)); // 1st 00:00 UTC
  const periodEnd = new Date(Date.UTC(y, m, 1)); // next month 1st 00:00 UTC (exclusive)
  const periodEndDisplay = new Date(Date.UTC(y, m, 0)); // last day of billing month

  // Due date = 23:59:59.999 BST on the Nth day from now
  const dueDate = endOfDayBST(nowUtc, DUE_DAYS);

  const triggeredBy = options.triggeredBy || "cron";

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
        breakdown: {
          monthlyFee,
          perInvoiceFee,
          commission,
          perInvoiceNet,
        },
        totalAmount: isFree ? 0 : totalAmount,
        status: isFree ? "free" : "unpaid",
        dueDate: isFree ? null : dueDate, // UTC ms, snapped to 23:59:59 BST
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

  // ── Record the run ────────────────────────────────────────────────────────
  const runDoc = {
    period: periodStart.toISOString().slice(0, 7), // "YYYY-MM"
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
    JSON.stringify({ period: runDoc.period, generated, free, skipped, failedCount: failedLabs.length }),
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

  // Re-compute due date from *now* (retry may happen days later)
  const dueDate = endOfDayBST(nowUtc, DUE_DAYS);

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
