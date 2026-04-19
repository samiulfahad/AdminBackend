import toObjectId from "../../utils/db.js";

async function billingRoutes(fastify) {
  const col = () => fastify.mongo.db.collection("billings");
  const runsCol = () => fastify.mongo.db.collection("billingRuns");

  fastify.addHook("onRequest", fastify.authenticate);

  const requireAdmin = (req, reply) => {
    if (!["admin", "supportAdmin"].includes(req.user.role)) {
      return reply.code(403).send({ error: "Forbidden" });
    }
  };

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
        requireAdmin(req, reply);

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
        requireAdmin(req, reply);

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
        summary: "Mark a bill as paid (admin or supportAdmin only)",
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
        requireAdmin(req, reply);

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
              paidBy: { id: toObjectId(req.user.id), name: req.user.name },
            },
          },
        );

        if (result.matchedCount === 0) {
          return reply.code(404).send({ error: "Bill not found or already paid" });
        }

        // ── Signal lab-api to drop this lab from its blocked cache ────────
        // Non-fatal — if lab-api unreachable, cache expires in 5 min anyway
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
}

export default billingRoutes;
