import toObjectId from "../../utils/db.js";
import { generateMonthlyBills, retryFailedLabs } from "../../jobs/generateMonthlyBills.js";

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
        const filter = req.query.status ? { status: req.query.status } : {};

        const bills = await col()
          .find(filter, {
            projection: {
              labId: 1,
              status: 1,
              totalAmount: 1,
              dueDate: 1,
              billingPeriodStart: 1,
              billingPeriodEnd: 1,
              invoiceCount: 1,
              breakdown: 1,
              paidAt: 1,
              paidBy: 1,
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
        },
      },
    },
    async (req, reply) => {
      try {
        const labId = toObjectId(req.body.labId);

        const result = await col().updateOne(
          {
            _id: toObjectId(req.params.billingId),
            labId,
            status: "unpaid",
          },
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
  fastify.post(
    "/billing/generate",
    {
      schema: {
        tags: ["Billing"],
        summary: "Manually trigger bill generation (idempotent)",
        body: {
          type: "object",
          properties: {
            year: { type: "integer", minimum: 2024, maximum: 2100 },
            month: { type: "integer", minimum: 1, maximum: 12 },
          },
        },
      },
    },
    async (req, reply) => {
      try {
        const DHAKA_OFFSET_MS = 6 * 60 * 60 * 1000;
        const options = { triggeredBy: "manual" };

        if (req.body?.year && req.body?.month) {
          const requestedYear = parseInt(req.body.year);
          const requestedMonth = parseInt(req.body.month); // 1-indexed

          // Guard: prevent generating bills for the current or a future month.
          // Bills can only be generated after the month is fully over.
          const nowDhaka = new Date(Date.now() + DHAKA_OFFSET_MS);
          const currentYear = nowDhaka.getUTCFullYear();
          const currentMonth = nowDhaka.getUTCMonth() + 1; // 1-indexed

          const isCurrentOrFuture =
            requestedYear > currentYear || (requestedYear === currentYear && requestedMonth >= currentMonth);

          if (isCurrentOrFuture) {
            return reply.code(400).send({
              error: `Cannot generate bills for ${requestedYear}-${String(requestedMonth).padStart(2, "0")}. Bills can only be generated after the month has ended.`,
            });
          }

          options.year = requestedYear;
          options.month = requestedMonth;
        }

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

  // ── POST /billing/runs/:runId/retry-failed ───────────────────────────────
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

        if (!run) {
          return reply.code(404).send({ error: "Run not found" });
        }

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
