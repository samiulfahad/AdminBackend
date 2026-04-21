// ── routes/billing/billing.js ─────────────────────────────────────────────────

import { nowBST, endOfDayBST, parseDateStringToBSTEndOfDay } from "../../utils/time.js";
import { generateMonthlyBills, retryFailedLabs } from "../../jobs/generateMonthlyBills.js";

// @fastify/mongodb exposes fastify.mongo.db — ObjectIds come back as native BSON
// from the driver; we never need to manually coerce them for find/aggregate.
// For params that arrive as strings we use the driver's ObjectId directly.
import { ObjectId } from "@fastify/mongodb";

const toOid = (v) => {
  try {
    return new ObjectId(v);
  } catch {
    return null;
  }
};

async function billingRoutes(fastify) {
  const col = () => fastify.mongo.db.collection("billings");
  const runsCol = () => fastify.mongo.db.collection("billingRuns");

  // ── GET /billing/unpaid-labs ──────────────────────────────────────────────
  // Lightweight summary only — unpaid bill totals + month tags per lab.
  // History is NOT included; load it on demand via /billing/lab/:labKey/history.
  fastify.get(
    "/billing/unpaid-labs",
    {
      schema: {
        tags: ["Billing"],
        summary: "Labs with unpaid bills — grouped summary only (no history)",
        querystring: {
          type: "object",
          properties: {
            limit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
            skip: { type: "integer", minimum: 0, default: 0 },
            search: { type: "string" },
          },
        },
      },
    },
    async (req, reply) => {
      try {
        const limit = Math.min(req.query.limit ?? 20, 100);
        const skip = req.query.skip ?? 0;
        const search = req.query.search?.trim() || null;

        const searchStage = search
          ? [
              {
                $match: {
                  $or: [{ "labDoc.labKey": search }, { "labDoc.name": { $regex: search, $options: "i" } }],
                },
              },
            ]
          : [];

        // Single pass: group unpaid bills → join lab → facet for count + page
        const pipeline = [
          { $match: { status: "unpaid" } },
          { $sort: { billingPeriodStart: -1 } },
          {
            $group: {
              _id: "$labId",
              unpaidTotal: { $sum: "$totalAmount" },
              bills: {
                $push: {
                  billingId: "$_id",
                  billingPeriodStart: "$billingPeriodStart",
                  billingPeriodEnd: "$billingPeriodEnd",
                  dueDate: "$dueDate",
                  totalAmount: "$totalAmount",
                  invoiceCount: "$invoiceCount",
                },
              },
            },
          },
          {
            $lookup: {
              from: "labs",
              localField: "_id",
              foreignField: "_id",
              as: "labDoc",
              pipeline: [{ $project: { name: 1, labKey: 1, isActive: 1 } }],
            },
          },
          // ✅ preserveNullAndEmptyArrays (not preserveNullAndEmpty)
          { $unwind: { path: "$labDoc", preserveNullAndEmptyArrays: false } },
          ...searchStage,
          { $sort: { unpaidTotal: -1 } },
          {
            $facet: {
              total: [{ $count: "n" }],
              labs: [{ $skip: skip }, { $limit: limit }],
            },
          },
        ];

        const [result] = await col().aggregate(pipeline).toArray();

        const total = result?.total?.[0]?.n ?? 0;
        const now = Date.now();
        const MONTH_FMT = new Intl.DateTimeFormat("en-GB", { month: "short", year: "numeric" });

        const labs = (result?.labs ?? []).map((doc) => ({
          labId: doc._id,
          labKey: doc.labDoc.labKey,
          labName: doc.labDoc.name,
          isActive: doc.labDoc.isActive,
          unpaidTotal: doc.unpaidTotal,
          unpaidMonths: doc.bills.map((b) => ({
            billingId: b.billingId,
            month: MONTH_FMT.format(new Date(b.billingPeriodStart)),
            billingPeriodStart: b.billingPeriodStart,
            billingPeriodEnd: b.billingPeriodEnd,
            dueDate: b.dueDate,
            isOverdue: now > b.dueDate,
            totalAmount: b.totalAmount,
            invoiceCount: b.invoiceCount ?? 0,
          })),
        }));

        return reply.send({ labs, total });
      } catch (err) {
        req.log.error(err);
        return reply.code(500).send({ error: "Failed to fetch unpaid labs" });
      }
    },
  );

  // ── GET /billing/lab/:labKey/history ──────────────────────────────────────
  // On-demand: only called when user expands a lab row.
  fastify.get(
    "/billing/lab/:labKey/history",
    {
      schema: {
        tags: ["Billing"],
        summary: "Paginated billing history for a lab — fetched on demand",
        params: {
          type: "object",
          required: ["labKey"],
          properties: { labKey: { type: "string", minLength: 1, maxLength: 50 } },
        },
        querystring: {
          type: "object",
          properties: {
            limit: { type: "integer", minimum: 1, maximum: 48, default: 12 },
            skip: { type: "integer", minimum: 0, default: 0 },
          },
        },
      },
    },
    async (req, reply) => {
      try {
        const lab = await fastify.mongo.db
          .collection("labs")
          .findOne({ labKey: req.params.labKey }, { projection: { name: 1, labKey: 1, isActive: 1 } });
        if (!lab) return reply.code(404).send({ error: "Lab not found" });

        const limit = Math.min(req.query.limit ?? 12, 48);
        const skip = req.query.skip ?? 0;

        const [bills, total, aggregate] = await Promise.all([
          col()
            .find(
              { labId: lab._id },
              {
                projection: {
                  status: 1,
                  totalAmount: 1,
                  dueDate: 1,
                  billingPeriodStart: 1,
                  billingPeriodEnd: 1,
                  invoiceCount: 1,
                  breakdown: 1,
                  paidAt: 1,
                },
              },
            )
            .sort({ billingPeriodStart: -1 })
            .skip(skip)
            .limit(limit)
            .toArray(),

          col().countDocuments({ labId: lab._id }),

          col()
            .aggregate([
              { $match: { labId: lab._id } },
              { $group: { _id: "$status", count: { $sum: 1 }, total: { $sum: "$totalAmount" } } },
            ])
            .toArray(),
        ]);

        const stats = {
          paid: { count: 0, total: 0 },
          unpaid: { count: 0, total: 0 },
          free: { count: 0, total: 0 },
        };
        for (const g of aggregate) {
          if (g._id in stats) stats[g._id] = { count: g.count, total: g.total };
        }

        return reply.send({ lab, bills, total, stats });
      } catch (err) {
        req.log.error(err);
        return reply.code(500).send({ error: "Failed to fetch lab billing history" });
      }
    },
  );

  // ── GET /billing/lab/:labKey/summary ──────────────────────────────────────
  // Used by Lab Lookup tab.
  fastify.get(
    "/billing/lab/:labKey/summary",
    {
      schema: {
        tags: ["Billing"],
        summary: "Current unpaid bill + aggregate stats for a lab by labKey",
        params: {
          type: "object",
          required: ["labKey"],
          properties: { labKey: { type: "string", minLength: 1, maxLength: 50 } },
        },
      },
    },
    async (req, reply) => {
      try {
        const lab = await fastify.mongo.db
          .collection("labs")
          .findOne({ labKey: req.params.labKey }, { projection: { name: 1, labKey: 1, isActive: 1 } });
        if (!lab) return reply.code(404).send({ error: "Lab not found" });

        const [unpaidBill, aggregate] = await Promise.all([
          col().findOne({ labId: lab._id, status: "unpaid" }, { sort: { billingPeriodStart: -1 } }),
          col()
            .aggregate([
              { $match: { labId: lab._id } },
              { $group: { _id: "$status", count: { $sum: 1 }, total: { $sum: "$totalAmount" } } },
            ])
            .toArray(),
        ]);

        const stats = {
          paid: { count: 0, total: 0 },
          unpaid: { count: 0, total: 0 },
          free: { count: 0, total: 0 },
        };
        for (const g of aggregate) {
          if (g._id in stats) stats[g._id] = { count: g.count, total: g.total };
        }

        const currentBill = unpaidBill
          ? {
              id: unpaidBill._id,
              amount: unpaidBill.totalAmount,
              dueDate: unpaidBill.dueDate,
              isOverdue: Date.now() > unpaidBill.dueDate,
              billingPeriodStart: unpaidBill.billingPeriodStart,
              billingPeriodEnd: unpaidBill.billingPeriodEnd,
              invoiceCount: unpaidBill.invoiceCount,
              breakdown: unpaidBill.breakdown,
            }
          : null;

        return reply.send({ lab, currentBill, stats });
      } catch (err) {
        req.log.error(err);
        return reply.code(500).send({ error: "Failed to fetch lab billing summary" });
      }
    },
  );

  // ── GET /billing/runs ─────────────────────────────────────────────────────
  fastify.get(
    "/billing/runs",
    {
      schema: {
        tags: ["Billing"],
        summary: "Billing run history",
        querystring: {
          type: "object",
          properties: {
            limit: { type: "integer", minimum: 1, maximum: 50, default: 20 },
            skip: { type: "integer", minimum: 0, default: 0 },
            hasErrors: { type: "string", enum: ["true", "false"] },
          },
        },
      },
    },
    async (req, reply) => {
      try {
        const limit = Math.min(req.query.limit ?? 20, 50);
        const skip = req.query.skip ?? 0;
        const filter = req.query.hasErrors === "true" ? { hasErrors: true } : {};

        const runs = await runsCol()
          .find(filter, {
            projection: {
              period: 1,
              billingPeriodStart: 1,
              triggeredBy: 1,
              triggeredAt: 1,
              totalLabs: 1,
              generated: 1,
              free: 1,
              skipped: 1,
              failedCount: 1,
              failedLabs: 1,
              hasErrors: 1,
              lastRetryAt: 1,
              retryResult: 1,
            },
          })
          .sort({ triggeredAt: -1 })
          .skip(skip)
          .limit(limit)
          .toArray();

        return reply.send({ runs });
      } catch (err) {
        req.log.error(err);
        return reply.code(500).send({ error: "Failed to fetch billing runs" });
      }
    },
  );

  // ── POST /billing/pay/:billingId ──────────────────────────────────────────
  fastify.post(
    "/billing/pay/:billingId",
    {
      schema: {
        tags: ["Billing"],
        summary: "Mark a bill as paid",
        params: {
          type: "object",
          required: ["billingId"],
          properties: { billingId: { type: "string", minLength: 24, maxLength: 24 } },
        },
        body: {
          type: "object",
          required: ["labId"],
          properties: { labId: { type: "string", minLength: 24, maxLength: 24 } },
          additionalProperties: false,
        },
      },
    },
    async (req, reply) => {
      try {
        const billingOid = toOid(req.params.billingId);
        const labOid = toOid(req.body.labId);
        if (!billingOid || !labOid) return reply.code(400).send({ error: "Invalid ID format" });

        const result = await col().updateOne(
          { _id: billingOid, labId: labOid, status: "unpaid" },
          { $set: { status: "paid", paidAt: Date.now(), paidBy: { id: "admin", name: "Admin" } } },
        );

        if (result.matchedCount === 0) {
          return reply.code(404).send({ error: "Bill not found or already paid" });
        }

        fetch(`${process.env.LAB_API_INTERNAL_URL}/internal/billing/cache-invalidate/${req.body.labId}`, {
          method: "POST",
          headers: { "x-internal-secret": process.env.INTERNAL_SECRET },
        }).catch(() => req.log.warn("[billing] Could not invalidate billing cache"));

        return reply.send({ success: true });
      } catch (err) {
        req.log.error(err);
        return reply.code(500).send({ error: "Failed to mark bill as paid" });
      }
    },
  );

  // ── PATCH /billing/:billingId/due-date ────────────────────────────────────
  fastify.patch(
    "/billing/:billingId/due-date",
    {
      schema: {
        tags: ["Billing"],
        summary: "Extend due date of an unpaid bill (max +10 days)",
        params: {
          type: "object",
          required: ["billingId"],
          properties: { billingId: { type: "string", minLength: 24, maxLength: 24 } },
        },
        body: {
          type: "object",
          required: ["dueDate"],
          properties: {
            dueDate: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
          },
          additionalProperties: false,
        },
      },
    },
    async (req, reply) => {
      try {
        const oid = toOid(req.params.billingId);
        if (!oid) return reply.code(400).send({ error: "Invalid billing ID" });

        let newDueDateMs;
        try {
          newDueDateMs = parseDateStringToBSTEndOfDay(req.body.dueDate);
        } catch (e) {
          return reply.code(400).send({ error: e.message });
        }

        if (newDueDateMs <= Date.now()) {
          return reply.code(400).send({ error: "Due date must be in the future (BST)." });
        }

        const bill = await col().findOne({ _id: oid, status: "unpaid" }, { projection: { dueDate: 1 } });
        if (!bill) return reply.code(404).send({ error: "Bill not found or is not unpaid." });

        const maxAllowedMs = endOfDayBST(bill.dueDate + 10 * 24 * 60 * 60 * 1000);
        if (newDueDateMs > maxAllowedMs) {
          const maxBSTDate = new Date(maxAllowedMs + 6 * 60 * 60 * 1000).toISOString().slice(0, 10);
          return reply.code(400).send({
            error: `Max allowed: ${maxBSTDate} (BST). Cannot extend more than 10 days.`,
            maxAllowedBSTDate: maxBSTDate,
          });
        }

        await col().updateOne({ _id: oid }, { $set: { dueDate: newDueDateMs } });
        return reply.send({ success: true, dueDate: newDueDateMs, dueDateBST: req.body.dueDate });
      } catch (err) {
        req.log.error(err);
        return reply.code(500).send({ error: "Failed to update due date." });
      }
    },
  );

  // ── POST /billing/generate ────────────────────────────────────────────────
  fastify.post(
    "/billing/generate",
    {
      schema: {
        tags: ["Billing"],
        summary: "Manually trigger bill generation (idempotent per period)",
        body: {
          type: "object",
          properties: {
            year: { type: "integer", minimum: 2024, maximum: 2100 },
            month: { type: "integer", minimum: 1, maximum: 12 },
            dueDate: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
          },
          additionalProperties: false,
        },
      },
    },
    async (req, reply) => {
      try {
        const body = req.body ?? {};
        const options = { triggeredBy: "manual" };

        if (body.year != null || body.month != null) {
          if (body.year == null || body.month == null) {
            return reply.code(400).send({ error: "Both year and month must be provided together." });
          }
          const bstNow = nowBST();
          const y = parseInt(body.year, 10);
          const m = parseInt(body.month, 10);
          if (y > bstNow.year || (y === bstNow.year && m >= bstNow.month)) {
            return reply.code(400).send({
              error: `Cannot generate bills for ${y}-${String(m).padStart(2, "0")}. Month must have ended (BST).`,
            });
          }
          options.year = y;
          options.month = m;
        }

        if (body.dueDate) {
          try {
            options.dueDateMs = parseDateStringToBSTEndOfDay(body.dueDate);
          } catch (e) {
            return reply.code(400).send({ error: e.message });
          }
          if (options.dueDateMs <= Date.now()) {
            return reply.code(400).send({ error: "dueDate must be a future date (BST)." });
          }
        }

        generateMonthlyBills(fastify.mongo.db, options)
          .then((r) => fastify.log.info({ r }, "[billing] Manual generation complete"))
          .catch((err) => fastify.log.error({ err }, "[billing] Manual generation failed"));

        return reply.send({
          message: "Bill generation started",
          options: {
            year: options.year ?? "auto (previous BST month)",
            month: options.month ?? "auto (previous BST month)",
            dueDate: body.dueDate ?? `${process.env.BILLING_DUE_DAYS ?? 7} days from now (BST)`,
          },
        });
      } catch (err) {
        req.log.error(err);
        return reply.code(500).send({ error: "Failed to start bill generation" });
      }
    },
  );

  // ── POST /billing/runs/:runId/retry-failed ────────────────────────────────
  fastify.post(
    "/billing/runs/:runId/retry-failed",
    {
      schema: {
        tags: ["Billing"],
        summary: "Retry failed labs from a billing run",
        params: {
          type: "object",
          required: ["runId"],
          properties: { runId: { type: "string", minLength: 24, maxLength: 24 } },
        },
      },
    },
    async (req, reply) => {
      try {
        const oid = toOid(req.params.runId);
        if (!oid) return reply.code(400).send({ error: "Invalid run ID" });

        const run = await runsCol().findOne(
          { _id: oid },
          { projection: { failedLabs: 1, billingPeriodStart: 1, period: 1 } },
        );
        if (!run) return reply.code(404).send({ error: "Run not found" });
        if (!run.failedLabs?.length) return reply.send({ message: "No failed labs in this run" });

        retryFailedLabs(fastify.mongo.db, run)
          .then((r) => fastify.log.info({ r }, "[billing] Retry complete"))
          .catch((err) => fastify.log.error({ err }, "[billing] Retry failed"));

        return reply.send({ message: `Retrying ${run.failedLabs.length} failed lab(s) from ${run.period}` });
      } catch (err) {
        req.log.error(err);
        return reply.code(500).send({ error: "Failed to start retry" });
      }
    },
  );

  // ── ADD THIS ROUTE to billing.js (inside billingRoutes function) ───────────────
  //
  // GET /billing/month-overview
  // Returns all billing periods grouped by month with paid/unpaid/free counts + totals.
  // Used by the new "Month Overview" tab in AdminBilling.jsx.

  fastify.get(
    "/billing/month-overview",
    {
      schema: {
        tags: ["Billing"],
        summary: "All billing periods grouped by month — paid/unpaid/free counts and totals",
      },
    },
    async (req, reply) => {
      try {
        const pipeline = [
          // Group by billingPeriodStart (each period is one month), then by status
          {
            $group: {
              _id: {
                periodStart: "$billingPeriodStart",
                status: "$status",
              },
              count: { $sum: 1 },
              total: { $sum: "$totalAmount" },
            },
          },
          // Reshape: one doc per period with paid/unpaid/free sub-objects
          {
            $group: {
              _id: "$_id.periodStart",
              statuses: {
                $push: {
                  status: "$_id.status",
                  count: "$count",
                  total: "$total",
                },
              },
            },
          },
          { $sort: { _id: -1 } }, // newest first
        ];

        const raw = await col().aggregate(pipeline).toArray();

        const MONTH_FMT = new Intl.DateTimeFormat("en-GB", { month: "short", year: "numeric" });

        const months = raw.map((doc) => {
          const periodStart = doc._id; // UTC ms
          const date = new Date(periodStart);

          // Build status map
          const stats = { paid: { count: 0, total: 0 }, unpaid: { count: 0, total: 0 }, free: { count: 0, total: 0 } };
          for (const s of doc.statuses) {
            if (s.status in stats) stats[s.status] = { count: s.count, total: s.total };
          }

          // BST year: shift by +6h to get BST date, then read UTC year/month
          const bstMs = periodStart + 6 * 60 * 60 * 1000;
          const bstDate = new Date(bstMs);

          return {
            period: `${bstDate.getUTCFullYear()}-${String(bstDate.getUTCMonth() + 1).padStart(2, "0")}`,
            label: MONTH_FMT.format(date),
            year: bstDate.getUTCFullYear(),
            month: bstDate.getUTCMonth() + 1, // 1-indexed
            periodStart,
            totalLabs: stats.paid.count + stats.unpaid.count + stats.free.count,
            paid: stats.paid,
            unpaid: stats.unpaid,
            free: stats.free,
          };
        });

        return reply.send({ months });
      } catch (err) {
        req.log.error(err);
        return reply.code(500).send({ error: "Failed to fetch monthly billing overview" });
      }
    },
  );
}

export default billingRoutes;
