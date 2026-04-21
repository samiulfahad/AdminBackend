// ── routes/billing/billing.js  (admin backend) ───────────────────────────────

import toObjectId from "../../utils/db.js";
import { nowBST, endOfDayBST, parseDateStringToBSTEndOfDay } from "../../utils/time.js";
import { generateMonthlyBills, retryFailedLabs } from "../../jobs/generateMonthlyBills.js";

async function billingRoutes(fastify) {
  const col = () => fastify.mongo.db.collection("billings");
  const runsCol = () => fastify.mongo.db.collection("billingRuns");

  // ── GET /billing/unpaid-labs ──────────────────────────────────────────────
  // Labs with unpaid bills — grouped by lab, with per-month tags.
  fastify.get(
    "/billing/unpaid-labs",
    {
      schema: {
        tags: ["Billing"],
        summary: "Labs with unpaid bills — grouped, with month tags",
        querystring: {
          type: "object",
          properties: {
            limit: { type: "integer", minimum: 1, maximum: 100, default: 50 },
            skip: { type: "integer", minimum: 0, default: 0 },
            search: { type: "string" },
          },
        },
      },
    },
    async (req, reply) => {
      try {
        const limit = Math.min(req.query.limit ?? 50, 100);
        const skip = req.query.skip ?? 0;
        const search = req.query.search?.trim();

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
                  breakdown: "$breakdown",
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
          { $unwind: { path: "$labDoc", preserveNullAndEmpty: false } },
          ...(search
            ? [
                {
                  $match: {
                    $or: [{ "labDoc.labKey": search }, { "labDoc.name": { $regex: search, $options: "i" } }],
                  },
                },
              ]
            : []),
          { $sort: { unpaidTotal: -1 } },
        ];

        const [countResult, labDocs] = await Promise.all([
          col()
            .aggregate([...pipeline, { $count: "total" }])
            .toArray(),
          col()
            .aggregate([...pipeline, { $skip: skip }, { $limit: limit }])
            .toArray(),
        ]);

        const total = countResult[0]?.total ?? 0;
        const now = Date.now();
        const MONTH_FMT = new Intl.DateTimeFormat("en-GB", { month: "short", year: "numeric" });

        const labs = labDocs.map((doc) => ({
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
            breakdown: b.breakdown ?? null,
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
  // Full paginated billing history for a lab, looked up by labKey.
  fastify.get(
    "/billing/lab/:labKey/history",
    {
      schema: {
        tags: ["Billing"],
        summary: "Full billing history for a lab by labKey",
        params: {
          type: "object",
          required: ["labKey"],
          properties: {
            labKey: { type: "string", minLength: 1, maxLength: 50 },
          },
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
                  createdAt: 1,
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
  // Current unpaid bill + aggregate stats for a lab, looked up by labKey.
  fastify.get(
    "/billing/lab/:labKey/summary",
    {
      schema: {
        tags: ["Billing"],
        summary: "Current unpaid bill + aggregate summary for a lab by labKey",
        params: {
          type: "object",
          required: ["labKey"],
          properties: {
            labKey: { type: "string", minLength: 1, maxLength: 50 },
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
        summary: "Get billing run history",
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
        summary: "Mark a bill as paid (admin)",
        params: {
          type: "object",
          required: ["billingId"],
          properties: {
            billingId: { type: "string", minLength: 24, maxLength: 24 },
          },
        },
        body: {
          type: "object",
          required: ["labId"],
          properties: {
            labId: { type: "string", minLength: 24, maxLength: 24 },
          },
          additionalProperties: false,
        },
      },
    },
    async (req, reply) => {
      try {
        const labId = toObjectId(req.body.labId);

        const result = await col().updateOne(
          { _id: toObjectId(req.params.billingId), labId, status: "unpaid" },
          {
            $set: {
              status: "paid",
              paidAt: Date.now(),
              paidBy: { id: "admin", name: "Admin" },
            },
          },
        );

        if (result.matchedCount === 0) {
          return reply.code(404).send({ error: "Bill not found or already paid" });
        }

        // Best-effort cache invalidation — failure is non-fatal
        fetch(`${process.env.LAB_API_INTERNAL_URL}/internal/billing/cache-invalidate/${req.body.labId}`, {
          method: "POST",
          headers: { "x-internal-secret": process.env.INTERNAL_SECRET },
        }).catch(() => {
          req.log.warn("[billing] Could not reach lab-api to invalidate billing cache — expires in ~5 min");
        });

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
        summary: "Extend the due date of an unpaid bill (max +10 days from current due date, BST)",
        params: {
          type: "object",
          required: ["billingId"],
          properties: {
            billingId: { type: "string", minLength: 24, maxLength: 24 },
          },
        },
        body: {
          type: "object",
          required: ["dueDate"],
          properties: {
            dueDate: {
              type: "string",
              pattern: "^\\d{4}-\\d{2}-\\d{2}$",
              description: "New due date in BST, format YYYY-MM-DD.",
            },
          },
          additionalProperties: false,
        },
      },
    },
    async (req, reply) => {
      try {
        let newDueDateMs;
        try {
          newDueDateMs = parseDateStringToBSTEndOfDay(req.body.dueDate);
        } catch (e) {
          return reply.code(400).send({ error: e.message });
        }

        if (newDueDateMs <= Date.now()) {
          return reply.code(400).send({ error: "Due date must be in the future (BST)." });
        }

        const bill = await col().findOne(
          { _id: toObjectId(req.params.billingId), status: "unpaid" },
          { projection: { dueDate: 1, labId: 1 } },
        );

        if (!bill) return reply.code(404).send({ error: "Bill not found or is not unpaid." });

        const MAX_EXTENSION_MS = 10 * 24 * 60 * 60 * 1000;
        const maxAllowedMs = endOfDayBST(bill.dueDate + MAX_EXTENSION_MS);

        if (newDueDateMs > maxAllowedMs) {
          const maxBSTDate = new Date(maxAllowedMs + 6 * 60 * 60 * 1000).toISOString().slice(0, 10);
          return reply.code(400).send({
            error: `Due date cannot be more than 10 days beyond the current due date. Max allowed: ${maxBSTDate} (BST).`,
            maxAllowed: maxAllowedMs,
            maxAllowedBSTDate: maxBSTDate,
          });
        }

        await col().updateOne({ _id: toObjectId(req.params.billingId) }, { $set: { dueDate: newDueDateMs } });

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
            dueDate: {
              type: "string",
              pattern: "^\\d{4}-\\d{2}-\\d{2}$",
              description: "Due date in BST, format YYYY-MM-DD. Defaults to 7 days from now.",
            },
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

          const requestedYear = parseInt(body.year, 10);
          const requestedMonth = parseInt(body.month, 10);
          const bstNow = nowBST();

          const isSameOrFuture =
            requestedYear > bstNow.year || (requestedYear === bstNow.year && requestedMonth >= bstNow.month);

          if (isSameOrFuture) {
            return reply.code(400).send({
              error: `Cannot generate bills for ${requestedYear}-${String(requestedMonth).padStart(2, "0")}. Bills can only be generated after the month has ended (BST).`,
            });
          }

          options.year = requestedYear;
          options.month = requestedMonth;
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
          .then((result) => fastify.log.info({ result }, "[billing] Manual generation complete"))
          .catch((err) => fastify.log.error({ err }, "[billing] Manual generation failed"));

        return reply.send({
          message: "Bill generation started",
          options: {
            year: options.year ?? "auto (previous BST month)",
            month: options.month ?? "auto (previous BST month)",
            dueDate: body.dueDate ?? `${process.env.BILLING_DUE_DAYS ?? 7} days from now (end of day BST)`,
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
        summary: "Retry failed labs from a specific billing run",
        params: {
          type: "object",
          required: ["runId"],
          properties: {
            runId: { type: "string", minLength: 24, maxLength: 24 },
          },
        },
      },
    },
    async (req, reply) => {
      try {
        const run = await runsCol().findOne(
          { _id: toObjectId(req.params.runId) },
          { projection: { failedLabs: 1, billingPeriodStart: 1, period: 1 } },
        );

        if (!run) return reply.code(404).send({ error: "Run not found" });
        if (!run.failedLabs?.length) return reply.send({ message: "No failed labs in this run" });

        retryFailedLabs(fastify.mongo.db, run)
          .then((result) => fastify.log.info({ result }, "[billing] Retry complete"))
          .catch((err) => fastify.log.error({ err }, "[billing] Retry failed"));

        return reply.send({
          message: `Retrying ${run.failedLabs.length} failed lab(s) from ${run.period}`,
        });
      } catch (err) {
        req.log.error(err);
        return reply.code(500).send({ error: "Failed to start retry" });
      }
    },
  );
}

export default billingRoutes;
