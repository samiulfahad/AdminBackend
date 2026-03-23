import "dotenv/config";

import Fastify from "fastify";
import cors from "@fastify/cors";
import mongoPlugin from "./plugins/mongo.js";
import categoryRoutes from "./routes/category/category.js";
import testRoutes from "./routes/test/test.js";
import labRoutes from "./routes/lab/lab.js";
import zoneRoutes from "./routes/zone/zone.js";
import staffRoutes from "./routes/staff/staff.js";
import testSchemaRoutes from "./routes/testSchema/testSchema.js";
import demoReportRoutes from "./routes/demoReport/demoReport.js";

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
  origin: process.env.CORS_ORIGIN || "*",
  methods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
});

// ── Plugins ───────────────────────────────────────────────────────────────────
await fastify.register(mongoPlugin);

// ── Routes ────────────────────────────────────────────────────────────────────
fastify.register(categoryRoutes, { prefix: "/api/v1" });
fastify.register(testRoutes, { prefix: "/api/v1" });
fastify.register(labRoutes, { prefix: "/api/v1" });
fastify.register(zoneRoutes, { prefix: "/api/v1" });
fastify.register(staffRoutes, { prefix: "/api/v1" });
fastify.register(testSchemaRoutes, { prefix: "/api/v1" });
fastify.register(demoReportRoutes, { prefix: "/api/v1" });

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
