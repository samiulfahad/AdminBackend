import "dotenv/config";

import Fastify from "fastify";
import mongoPlugin from "./plugins/mongo.js";
import categoryRoutes from "./routes/category.js";
import testRoutes from "./routes/test.js";

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
await fastify.register(categoryRoutes, { prefix: "/api" });
await fastify.register(testRoutes, { prefix: "/api" });

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
