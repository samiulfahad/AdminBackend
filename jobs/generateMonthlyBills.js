import { endOfDayBST, previousBSTMonth, buildPeriod } from "../utils/bstTime.js";

const DEFAULT_DUE_DAYS = 7;

// ─── Core bill-generation logic for a single lab ──────────────────────────────

async function generateBillForLab(db, lab, periodStart, periodEnd, periodEndDisplay, dueDate, nowUtc) {
  const exists = await db
    .collection("billings")
    .findOne({ labId: lab._id, billingPeriodStart: periodStart }, { projection: { _id: 1 } });

  if (exists) return { result: "skipped" };

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
    // dueDate is stored as UTC ms = end of due day 23:59:59.999 BST
    dueDate: isFree ? null : dueDate,
    createdAt: nowUtc,
    paidAt: null,
    paidBy: null,
  });

  return { result: isFree ? "free" : "generated" };
}

// ─── Main export: generate bills for all labs for a billing period ─────────────
//
// options.year + options.month (1-indexed): generate for that specific past month.
// Otherwise: auto-detect the previous BST month (postpaid billing).
// options.triggeredBy: "cron" | "manual"

export async function generateMonthlyBills(db, options = {}) {
  const nowUtc = Date.now();
  const DUE_DAYS = parseInt(process.env.BILLING_DUE_DAYS) || DEFAULT_DUE_DAYS;
  const triggeredBy = options.triggeredBy || "cron";

  // Determine which month to bill
  let period;
  if (options.year && options.month) {
    period = buildPeriod(parseInt(options.year), parseInt(options.month));
  } else {
    period = previousBSTMonth();
  }

  const { periodStart, periodEnd, periodEndDisplay } = period;

  // dueDate = end of (today + DUE_DAYS) in BST, i.e. 23:59:59.999 BST of that day
  const dueDate = endOfDayBST(nowUtc + DUE_DAYS * 24 * 60 * 60 * 1000);

  const labs = await db
    .collection("labs")
    .find({ "deletion.status": { $ne: true } }, { projection: { _id: 1, name: 1, labKey: 1, billing: 1 } })
    .toArray();

  let generated = 0;
  let free = 0;
  let skipped = 0;
  const failedLabs = [];

  for (const lab of labs) {
    try {
      const { result } = await generateBillForLab(db, lab, periodStart, periodEnd, periodEndDisplay, dueDate, nowUtc);
      if (result === "skipped") skipped++;
      else if (result === "free") free++;
      else generated++;
    } catch (err) {
      failedLabs.push({
        labId: lab._id,
        labName: lab.name ?? "Unknown",
        error: err.message,
      });
    }
  }

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

// ─── Retry failed labs from a previous billing run ────────────────────────────

export async function retryFailedLabs(db, run) {
  const nowUtc = Date.now();
  const DUE_DAYS = parseInt(process.env.BILLING_DUE_DAYS) || DEFAULT_DUE_DAYS;

  const periodStart = run.periodStart;
  const periodEnd = new Date(Date.UTC(periodStart.getUTCFullYear(), periodStart.getUTCMonth() + 1, 1));
  const periodEndDisplay = new Date(Date.UTC(periodStart.getUTCFullYear(), periodStart.getUTCMonth() + 1, 0));
  // Recalculate due date from NOW so retried labs get reasonable grace period
  const dueDate = endOfDayBST(nowUtc + DUE_DAYS * 24 * 60 * 60 * 1000);

  const retried = [];
  const stillFailing = [];

  for (const failed of run.failedLabs) {
    try {
      const lab = await db
        .collection("labs")
        .findOne(
          { _id: failed.labId, "deletion.status": { $ne: true } },
          { projection: { _id: 1, name: 1, labKey: 1, billing: 1 } },
        );

      if (!lab) {
        stillFailing.push({ labId: failed.labId, labName: failed.labName, error: "Lab not found" });
        continue;
      }

      const { result } = await generateBillForLab(db, lab, periodStart, periodEnd, periodEndDisplay, dueDate, nowUtc);

      retried.push({ labId: failed.labId, labName: lab.name, result });
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
    JSON.stringify({ period: run.period, retried: retried.length, stillFailing: stillFailing.length }),
  );

  return { retried, stillFailing };
}
