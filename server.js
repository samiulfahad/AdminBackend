import Fastify from "fastify";
import mongoPlugin from "./plugins/mongo.js";
import categoryRoutes from "./routes/category.js";
import testRoutes from "./routes/test.js";

const fastify = Fastify({
  logger: {
    level: process.env.LOG_LEVEL || "info",
    transport:
      process.env.NODE_ENV !== "production"
        ? {
            target: "pino-pretty",
            options: { colorize: true, translateTime: "HH:MM:ss Z" },
          }
        : undefined,
  },
});

// ── Plugins ─────────────────────────────────────────────
await fastify.register(mongoPlugin);

// ── Routes ──────────────────────────────────────────────
await fastify.register(categoryRoutes, { prefix: "/api" });
await fastify.register(testRoutes, { prefix: "/api" });

// ── Health check ────────────────────────────────────────
fastify.get("/health", async () => ({ status: "ok" }));

// ── Start ────────────────────────────────────────────────
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || "0.0.0.0";

try {
  await fastify.listen({ port: PORT, host: HOST });
} catch (err) {
  fastify.log.error(err);
  process.exit(1);
}
