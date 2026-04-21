// ── routes/billing/billing.js  (admin backend) ───────────────────────────────

import toObjectId from "../../utils/db.js";
import { nowBST, endOfDayBST, parseDateStringToBSTEndOfDay } from "../../utils/time.js";
import { generateMonthlyBills, retryFailedLabs } from "../../jobs/generateMonthlyBills.js";

async function billingRoutes(fastify) {
  const col = () => fastify.mongo.db.collection("billings");
  const runsCol = () => fastify.mongo.db.collection("billingRuns");

  // ── GET /billing/all ──────────────────────────────────────────────────────
  fastify.get(
    "/billing/all",
    {
      schema: {
        tags: ["Billing"],
        summary: "Get all bills across all labs",
        querystring: {
          type: "object",
          properties: {
            status: { type: "string", enum: ["unpaid", "paid", "free"] },
            limit: { type: "integer", minimum: 1, maximum: 100, default: 50 },
            skip: { type: "integer", minimum: 0, default: 0 },
          },
        },
      },
    },
    async (req, reply) => {
      try {
        const limit = Math.min(req.query.limit ?? 50, 100);
        const skip = req.query.skip ?? 0;
        const filter = req.query.status ? { status: req.query.status } : {};

        const [bills, total] = await Promise.all([
          col()
            .find(filter, {
              projection: {
                labId: 1,
                labKey: 1,
                status: 1,
                totalAmount: 1,
                dueDate: 1,
                billingPeriodStart: 1,
                billingPeriodEnd: 1,
                invoiceCount: 1,
                breakdown: 1,
                paidAt: 1,
                paidBy: 1,
                createdAt: 1,
              },
            })
            .sort({ billingPeriodStart: -1 })
            .skip(skip)
            .limit(limit)
            .toArray(),
          col().countDocuments(filter),
        ]);

        return reply.send({ bills, total });
      } catch (err) {
        req.log.error(err);
        return reply.code(500).send({ error: "Failed to fetch bills" });
      }
    },
  );

  // ── GET /billing/lab/:labId ───────────────────────────────────────────────
  // Billing history for a single lab (up to 24 months), newest first.
  fastify.get(
    "/billing/lab/:labId",
    {
      schema: {
        tags: ["Billing"],
        summary: "Get billing history for a specific lab (by ID or labKey)",
        params: {
          type: "object",
          required: ["labId"],
          properties: {
            labId: { type: "string", minLength: 1 },
          },
        },
        querystring: {
          type: "object",
          properties: {
            status: { type: "string", enum: ["unpaid", "paid", "free"] },
            limit: { type: "integer", minimum: 1, maximum: 24, default: 24 },
            skip: { type: "integer", minimum: 0, default: 0 },
          },
        },
      },
    },
    async (req, reply) => {
      try {
        const identifier = req.params.labId.trim();
        let labQuery;

        if (/^[0-9a-fA-F]{24}$/.test(identifier)) {
          labQuery = { _id: toObjectId(identifier) };
        } else {
          labQuery = { labKey: identifier };
        }

        // Fetch lab to resolve exact ID
        const lab = await fastify.mongo.db
          .collection("labs")
          .findOne(labQuery, { projection: { name: 1, labKey: 1, billing: 1, isActive: 1 } });

        if (!lab) return reply.code(404).send({ error: "Lab not found" });

        const actualLabId = lab._id;
        const limit = Math.min(req.query.limit ?? 24, 24);
        const skip = req.query.skip ?? 0;

        const filter = { labId: actualLabId, ...(req.query.status ? { status: req.query.status } : {}) };

        const [bills, total] = await Promise.all([
          col()
            .find(filter, {
              projection: {
                status: 1,
                totalAmount: 1,
                dueDate: 1,
                billingPeriodStart: 1,
                billingPeriodEnd: 1,
                invoiceCount: 1,
                breakdown: 1,
                paidAt: 1,
                paidBy: 1,
                createdAt: 1,
              },
            })
            .sort({ billingPeriodStart: -1 })
            .skip(skip)
            .limit(limit)
            .toArray(),
          col().countDocuments(filter),
        ]);

        return reply.send({ lab, bills, total });
      } catch (err) {
        req.log.error(err);
        return reply.code(500).send({ error: "Failed to fetch lab billing history" });
      }
    },
  );

  // ── GET /billing/lab/:labId/summary ──────────────────────────────────────
  // Quick summary: current unpaid bill + totals for the lab.
  fastify.get(
    "/billing/lab/:labId/summary",
    {
      schema: {
        tags: ["Billing"],
        summary: "Unpaid bill + aggregate summary for a specific lab (by ID or labKey)",
        params: {
          type: "object",
          required: ["labId"],
          properties: {
            labId: { type: "string", minLength: 1 },
          },
        },
      },
    },
    async (req, reply) => {
      try {
        const identifier = req.params.labId.trim();
        let labQuery;

        if (/^[0-9a-fA-F]{24}$/.test(identifier)) {
          labQuery = { _id: toObjectId(identifier) };
        } else {
          labQuery = { labKey: identifier };
        }

        const lab = await fastify.mongo.db
          .collection("labs")
          .findOne(labQuery, { projection: { name: 1, labKey: 1, billing: 1, isActive: 1 } });

        if (!lab) return reply.code(404).send({ error: "Lab not found" });

        const actualLabId = lab._id;

        const [unpaidBill, aggregate] = await Promise.all([
          col().findOne({ labId: actualLabId, status: "unpaid" }, { sort: { billingPeriodStart: -1 } }),

          col()
            .aggregate([
              { $match: { labId: actualLabId } },
              {
                $group: {
                  _id: "$status",
                  count: { $sum: 1 },
                  total: { $sum: "$totalAmount" },
                },
              },
            ])
            .toArray(),
        ]);

        const stats = { paid: { count: 0, total: 0 }, unpaid: { count: 0, total: 0 }, free: { count: 0, total: 0 } };
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

        if (!run.failedLabs?.length) {
          return reply.send({ message: "No failed labs in this run" });
        }

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
