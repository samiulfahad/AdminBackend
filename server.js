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


const cronSchedule = process.env.BILLING_CRON_SCHEDULE || "1 0 1 * *";
cron.schedule(
  cronSchedule,
  async () => {
    fastify.log.info("[cron] Starting billing job");
    try {
      const result = await generateMonthlyBills(fastify.mongo.db);
      fastify.log.info({ result }, "[cron] Billing job complete");
    } catch (err) {
      fastify.log.error({ err }, "[cron] Billing job failed");
    }
  },
  { timezone: "Asia/Dhaka" },
);