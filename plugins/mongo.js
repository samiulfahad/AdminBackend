import fastifyPlugin from "fastify-plugin";
import mongoPlugin from "@fastify/mongodb";

// fastify-plugin v5 uses a default export — named `fp` alias no longer needed
export default fastifyPlugin(async function (fastify) {
  const mongoUri = process.env.MONGO_URI || "mongodb://localhost:27017";

  await fastify.register(mongoPlugin, {
    forceClose: true,
    url: mongoUri,
  });

  fastify.log.info(`MongoDB connected: ${mongoUri}`);
});
