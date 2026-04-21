// ── routes/admin/billingRoutes.js ────────────────────────────────────────────
//
// Admin-side billing routes.
// All timestamps stored as UTC ms. "BST" = Asia/Dhaka = UTC+6.
//
// Due-date rule: always snapped to 23:59:59.999 BST = 17:59:59.999 UTC.

import toObjectId from "../../utils/db.js";
import { generateMonthlyBills, retryFailedLabs } from "../../jobs/generateMonthlyBills.js";

const DHAKA_OFFSET_MS = 6 * 60 * 60 * 1000;

/**
 * Snap a UTC ms timestamp to 23:59:59.999 on the **same BST calendar day**.
 * Used when the admin picks a date string like "2025-05-07" and we must store
 * the correct UTC deadline.
 *
 * @param {string} dateStr  "YYYY-MM-DD" in BST
 * @returns {number} UTC ms
 */
function dueDateFromBSTDateString(dateStr) {
  // Parse as midnight UTC, then add 6 h to get midnight BST,
  // then set to 23:59:59.999 BST by adding 17h 59m 59s 999ms more.
  // Simpler: just build Date.UTC with the date components + 17:59:59.999
  const [y, mo, d] = dateStr.split("-").map(Number);
  // 23:59:59.999 BST  =  17:59:59.999 UTC  (BST is UTC+6)
  return Date.UTC(y, mo - 1, d, 17, 59, 59, 999);
}

/**
 * Returns true if the given { year, month } (1-indexed) is the current or a
 * future month in BST.
 */
function isCurrentOrFutureMonthBST(year, month) {
  const nowBst = new Date(Date.now() + DHAKA_OFFSET_MS);
  const curYear = nowBst.getUTCFullYear();
  const curMon = nowBst.getUTCMonth() + 1; // 1-indexed
  return year > curYear || (year === curYear && month >= curMon);
}

// ─────────────────────────────────────────────────────────────────────────────

async function billingRoutes(fastify) {
  const col = () => fastify.mongo.db.collection("billings");
  const runsCol = () => fastify.mongo.db.collection("billingRuns");

  // ── GET /billing/all ───────────────────────────────────────────────────────
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

  // ── GET /billing/lab/:labId ────────────────────────────────────────────────
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

  // ── GET /billing/runs ──────────────────────────────────────────────────────
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

  // ── POST /billing/pay/:billingId ───────────────────────────────────────────
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

        // Fire-and-forget: invalidate the billing guard cache in the lab server
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

  // ── POST /billing/generate ─────────────────────────────────────────────────
  // Manual trigger. Body may include { year, month } (1-indexed).
  // Guard: cannot generate for the current or a future BST month.
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
        },
      },
    },
    async (req, reply) => {
      try {
        const options = { triggeredBy: "manual" };

        if (req.body?.year && req.body?.month) {
          const requestedYear = parseInt(req.body.year);
          const requestedMonth = parseInt(req.body.month); // 1-indexed

          if (isCurrentOrFutureMonthBST(requestedYear, requestedMonth)) {
            return reply.code(400).send({
              error: `Cannot generate bills for ${requestedYear}-${String(requestedMonth).padStart(2, "0")}. Bills can only be generated after the month has fully ended (BST).`,
            });
          }

          options.year = requestedYear;
          options.month = requestedMonth;
        }
        // If no year/month provided, the job defaults to previousBSTMonth()

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

  // ── PATCH /billing/:billingId/due-date ─────────────────────────────────────
  // Body: { dueDate: "YYYY-MM-DD" }  (BST calendar date picked by admin)
  // The date is always stored as 23:59:59.999 BST = 17:59:59.999 UTC.
  // Max extension: +10 days from current dueDate.
  fastify.patch(
    "/billing/:billingId/due-date",
    {
      schema: {
        tags: ["Billing"],
        summary: "Update the due date of an unpaid bill (accepts BST date string YYYY-MM-DD)",
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
            // Accept either a YYYY-MM-DD string OR a UTC ms integer for
            // backwards-compat with any existing callers.
            dueDate: {
              oneOf: [
                { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
                { type: "integer", minimum: 1 },
              ],
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

        // Normalise incoming value to UTC ms snapped to 23:59:59 BST
        let newDueDateMs;
        if (typeof req.body.dueDate === "string") {
          newDueDateMs = dueDateFromBSTDateString(req.body.dueDate);
        } else {
          // Legacy integer path: snap to end-of-BST-day of whatever day it falls on
          const bstDay = new Date(req.body.dueDate + DHAKA_OFFSET_MS);
          const dateStr = bstDay.toISOString().slice(0, 10);
          newDueDateMs = dueDateFromBSTDateString(dateStr);
        }

        if (newDueDateMs <= Date.now()) {
          return reply.code(400).send({ error: "Due date must be in the future." });
        }

        const MAX_EXTENSION_MS = 10 * 24 * 60 * 60 * 1000;
        const maxAllowed = bill.dueDate + MAX_EXTENSION_MS;

        if (newDueDateMs > maxAllowed) {
          // Display maxAllowed as BST date for error message
          const maxBst = new Date(maxAllowed + DHAKA_OFFSET_MS).toISOString().slice(0, 10);
          return reply.code(400).send({
            error: `Due date cannot be more than 10 days beyond the current due date (${maxBst} BST).`,
            maxAllowed, // UTC ms — frontend can use this too
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

  // ── POST /billing/runs/:runId/retry-failed ─────────────────────────────────
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
