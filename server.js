import "dotenv/config";

import Fastify from "fastify";
import mongoPlugin from "./plugins/mongo.js";
import categoryRoutes from "./routes/category/category.js";
import testRoutes from "./routes/test/test.js";
import labRoutes from "./routes/lab/lab.js";
import zoneRoutes from "./routes/zone/zone.js";
import kingoRoutes from "./routes/kingo/kingo.js";
import staffRoutes from "./routes/staff/staff.js";

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

// ── Plugins ───────────────────────────────────────────────────────────────────
await fastify.register(mongoPlugin);

// ── Routes ────────────────────────────────────────────────────────────────────
fastify.register(categoryRoutes, { prefix: "/api" });
fastify.register(testRoutes, { prefix: "/api" });
fastify.register(labRoutes, { prefix: "/api" });
fastify.register(zoneRoutes, { prefix: "/api" });
fastify.register(staffRoutes, { prefix: "/api" });
fastify.register(kingoRoutes, { prefix: "/api" });

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
