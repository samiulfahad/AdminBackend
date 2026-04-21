import toObjectId from "../../utils/db.js";
import { generateMonthlyBills, retryFailedLabs } from "../../jobs/generateMonthlyBills.js";
import { endOfDayBST, bstDateStringToEndOfDayUTC, currentBSTYearMonth } from "../../utils/bstTime.js";

async function billingRoutes(fastify) {
  const col = () => fastify.mongo.db.collection("billings");
  const runsCol = () => fastify.mongo.db.collection("billingRuns");

  // ── GET /billing/all ─────────────────────────────────────────────────────
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
            labId: { type: "string", minLength: 24, maxLength: 24 },
            limit: { type: "integer", minimum: 1, maximum: 100 },
            skip: { type: "integer", minimum: 0 },
          },
        },
      },
    },
    async (req, reply) => {
      try {
        const limit = Math.min(parseInt(req.query.limit) || 50, 100);
        const skip = parseInt(req.query.skip) || 0;

        const filter = {};
        if (req.query.status) filter.status = req.query.status;
        if (req.query.labId) filter.labId = toObjectId(req.query.labId);

        const bills = await col()
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
          .toArray();

        return reply.send({ bills });
      } catch (err) {
        req.log.error(err);
        return reply.code(500).send({ error: "Failed to fetch bills" });
      }
    },
  );

  // ── GET /billing/lab/:labId ──────────────────────────────────────────────
  // View billing history for a single lab
  fastify.get(
    "/billing/lab/:labId",
    {
      schema: {
        tags: ["Billing"],
        summary: "Get all bills for a specific lab",
        params: {
          type: "object",
          required: ["labId"],
          properties: {
            labId: { type: "string", minLength: 24, maxLength: 24 },
          },
        },
        querystring: {
          type: "object",
          properties: {
            limit: { type: "integer", minimum: 1, maximum: 100 },
            skip: { type: "integer", minimum: 0 },
          },
        },
      },
    },
    async (req, reply) => {
      try {
        const limit = Math.min(parseInt(req.query.limit) || 24, 100);
        const skip = parseInt(req.query.skip) || 0;

        const bills = await col()
          .find(
            { labId: toObjectId(req.params.labId) },
            {
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
            },
          )
          .sort({ billingPeriodStart: -1 })
          .skip(skip)
          .limit(limit)
          .toArray();

        return reply.send({ bills });
      } catch (err) {
        req.log.error(err);
        return reply.code(500).send({ error: "Failed to fetch lab bills" });
      }
    },
  );

  // ── GET /billing/runs ────────────────────────────────────────────────────
  fastify.get(
    "/billing/runs",
    {
      schema: {
        tags: ["Billing"],
        summary: "Get billing run history",
        querystring: {
          type: "object",
          properties: {
            limit: { type: "integer", minimum: 1, maximum: 50 },
            skip: { type: "integer", minimum: 0 },
            hasErrors: { type: "string", enum: ["true", "false"] },
          },
        },
      },
    },
    async (req, reply) => {
      try {
        const limit = Math.min(parseInt(req.query.limit) || 20, 50);
        const skip = parseInt(req.query.skip) || 0;
        const filter = req.query.hasErrors === "true" ? { hasErrors: true } : {};

        const runs = await runsCol()
          .find(filter, {
            projection: {
              period: 1,
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

  // ── POST /billing/pay/:billingId ─────────────────────────────────────────
  fastify.post(
    "/billing/pay/:billingId",
    {
      schema: {
        tags: ["Billing"],
        summary: "Mark a bill as paid",
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

        // Best-effort cache invalidation on the client server
        fetch(`${process.env.LAB_API_INTERNAL_URL}/internal/billing/cache-invalidate/${req.body.labId}`, {
          method: "POST",
          headers: { "x-internal-secret": process.env.INTERNAL_SECRET },
        }).catch(() => {
          req.log.warn("[billing] Could not reach lab-api to invalidate cache — expires in 5 min");
        });

        return reply.send({ success: true });
      } catch (err) {
        req.log.error(err);
        return reply.code(500).send({ error: "Failed to mark bill as paid" });
      }
    },
  );

  // ── POST /billing/generate ───────────────────────────────────────────────
  // Manually trigger bill generation for a specific past month.
  // Cannot generate for the current or future month.
  fastify.post(
    "/billing/generate",
    {
      schema: {
        tags: ["Billing"],
        summary: "Manually trigger bill generation for a past month (idempotent)",
        body: {
          type: "object",
          properties: {
            year: { type: "integer", minimum: 2024, maximum: 2100 },
            month: { type: "integer", minimum: 1, maximum: 12 },
          },
          additionalProperties: false,
        },
      },
    },
    async (req, reply) => {
      try {
        const options = { triggeredBy: "manual" };

        if (req.body?.year && req.body?.month) {
          const requestedYear = parseInt(req.body.year);
          const requestedMonth = parseInt(req.body.month); // 1-indexed

          // Guard: bills can only be generated for months that are fully over in BST.
          const { year: currentYear, month: currentMonth } = currentBSTYearMonth();

          const isCurrentOrFuture =
            requestedYear > currentYear || (requestedYear === currentYear && requestedMonth >= currentMonth);

          if (isCurrentOrFuture) {
            return reply.code(400).send({
              error: `Cannot generate bills for ${requestedYear}-${String(requestedMonth).padStart(2, "0")}. Bills can only be generated after the month has fully ended in BST.`,
            });
          }

          options.year = requestedYear;
          options.month = requestedMonth;
        }
        // If no year/month provided, defaults to previous BST month (same as cron)

        generateMonthlyBills(fastify.mongo.db, options)
          .then((result) => fastify.log.info({ result }, "[billing] Manual generation complete"))
          .catch((err) => fastify.log.error({ err }, "[billing] Manual generation failed"));

        return reply.send({ message: "Bill generation started", options });
      } catch (err) {
        req.log.error(err);
        return reply.code(500).send({ error: "Failed to start bill generation" });
      }
    },
  );

  // ── PATCH /billing/:billingId/due-date ────────────────────────────────────
  // Update due date of an unpaid bill.
  // Body: { dueDate: "YYYY-MM-DD" } — a BST calendar date string.
  // The backend converts it to 23:59:59.999 BST = 17:59:59.999 UTC of that day.
  // Max extension: +10 days beyond current due date (measured in BST calendar days).
  fastify.patch(
    "/billing/:billingId/due-date",
    {
      schema: {
        tags: ["Billing"],
        summary: "Update the due date of an unpaid bill",
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
            // Accept a "YYYY-MM-DD" BST date string from the frontend
            dueDate: {
              type: "string",
              pattern: "^\\d{4}-\\d{2}-\\d{2}$",
              description: "BST calendar date string YYYY-MM-DD",
            },
          },
          additionalProperties: false,
        },
      },
    },
    async (req, reply) => {
      try {
        const bill = await col().findOne(
          { _id: toObjectId(req.params.billingId), status: "unpaid" },
          { projection: { dueDate: 1 } },
        );

        if (!bill) {
          return reply.code(404).send({ error: "Bill not found or is not unpaid." });
        }

        // Convert the chosen BST date to end-of-day UTC
        const newDueDateMs = bstDateStringToEndOfDayUTC(req.body.dueDate);

        if (newDueDateMs <= Date.now()) {
          return reply.code(400).send({ error: "Due date must be in the future." });
        }

        const MAX_EXTENSION_MS = 10 * 24 * 60 * 60 * 1000;
        const maxAllowedMs = bill.dueDate + MAX_EXTENSION_MS;

        if (newDueDateMs > maxAllowedMs) {
          // Return the max date as a BST string so frontend can show it clearly
          const maxBSTDate = new Date(maxAllowedMs + 6 * 60 * 60 * 1000).toISOString().slice(0, 10);
          return reply.code(400).send({
            error: `Due date cannot be more than 10 days beyond the current due date (${maxBSTDate} BST).`,
            maxAllowed: maxAllowedMs,
          });
        }

        await col().updateOne({ _id: toObjectId(req.params.billingId) }, { $set: { dueDate: newDueDateMs } });

        return reply.send({ success: true, dueDate: newDueDateMs });
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
          { projection: { failedLabs: 1, periodStart: 1, period: 1 } },
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
