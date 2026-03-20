import Fastify from "fastify";
import mongoPlugin from "./plugins/mongo.js";
import categoryRoutes from "./routes/category.js";
import testCatalogRoutes from "./routes/testCatalog.js";

// v5: pino transport config stays in `logger`, but a custom pino *instance*
// would now use `loggerInstance` instead. Using built-in pino options here
// is still correct in v5.
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
await fastify.register(testCatalogRoutes, { prefix: "/api" });

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
