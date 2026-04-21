import "dotenv/config";

import Fastify from "fastify";
import cors from "@fastify/cors";
import cron from "node-cron";

import mongoPlugin from "./plugins/mongo.js";
import categoryRoutes from "./routes/category/category.js";
import testRoutes from "./routes/test/test.js";
import labRoutes from "./routes/lab/lab.js";
import zoneRoutes from "./routes/zone/zone.js";
import staffRoutes from "./routes/staff/staff.js";
import testSchemaRoutes from "./routes/testSchema/testSchema.js";
import demoReportRoutes from "./routes/demoReport/demoReport.js";
import billingRoutes from "./routes/billing/billing.js";
import { generateMonthlyBills } from "./jobs/generateMonthlyBills.js";

const fastify = Fastify({
  disableRequestLogging: true,
  logger: {
    transport: {
      target: "pino-pretty",
      options: {
        ignore: "pid,hostname,level,time,reqId,req,res,responseTime",
      },
    },
  },
});

// ── CORS ──────────────────────────────────────────────────────────────────────
await fastify.register(cors, {
  origin: ["https://lpadmin.netlify.app", "http://localhost:5173"],
  methods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
});

// ── Plugins ───────────────────────────────────────────────────────────────────
await fastify.register(mongoPlugin);

// ── Routes ────────────────────────────────────────────────────────────────────
const API = "/api/v1";

fastify.register(categoryRoutes, { prefix: API });
fastify.register(testRoutes, { prefix: API });
fastify.register(labRoutes, { prefix: API });
fastify.register(zoneRoutes, { prefix: API });
fastify.register(staffRoutes, { prefix: API });
fastify.register(testSchemaRoutes, { prefix: API });
fastify.register(demoReportRoutes, { prefix: API });
fastify.register(billingRoutes, { prefix: API });

// ── Health check ──────────────────────────────────────────────────────────────
fastify.get("/health", async () => ({ status: "ok" }));

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || "0.0.0.0";

try {
  await fastify.listen({ port: PORT, host: HOST });
} catch (err) {
  fastify.log.error(err);
  process.exit(1);
}

// ── Billing Cron ──────────────────────────────────────────────────────────────
//
// Fires at 12:05 AM BST on the 1st of every month.
// At that point the previous month has just ended in Bangladesh,
// so previousBSTMonth() in generateMonthlyBills will correctly return it.
//
// node-cron timezone: "Asia/Dhaka" handles DST-safe scheduling.
// No manual UTC offset math is needed here.
//
// Schedule format: "minute hour day month weekday"
//   "5 0 1 * *" = 00:05 on the 1st of every month (Dhaka time)
//
// Override via env: BILLING_CRON_SCHEDULE="5 0 1 * *"
//
// Retry logic: if the cron fails, the billingRuns document will have hasErrors=true
// and failed labs can be retried via POST /billing/runs/:runId/retry-failed.
// If the entire run fails (e.g. DB down), re-trigger manually via POST /billing/generate.

const cronSchedule = process.env.BILLING_CRON_SCHEDULE || "5 0 1 * *";

cron.schedule(
  cronSchedule,
  async () => {
    fastify.log.info("[cron] Starting monthly billing job");
    try {
      const result = await generateMonthlyBills(fastify.mongo.db, { triggeredBy: "cron" });
      fastify.log.info(
        {
          period: result.period,
          generated: result.generated,
          free: result.free,
          skipped: result.skipped,
          failedCount: result.failedCount,
        },
        "[cron] Billing job complete",
      );

      if (result.hasErrors) {
        fastify.log.warn(
          { failedLabs: result.failedLabs },
          `[cron] ${result.failedCount} lab(s) failed — retry via POST /billing/runs/:runId/retry-failed`,
        );
      }
    } catch (err) {
      fastify.log.error({ err }, "[cron] Billing job failed entirely — trigger manually via POST /billing/generate");
    }
  },
  {
    timezone: "Asia/Dhaka",
    // scheduled: true by default
  },
);

fastify.log.info(`[cron] Billing cron registered: "${cronSchedule}" (Asia/Dhaka)`);
