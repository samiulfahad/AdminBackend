import fastifyPlugin from "fastify-plugin";
import mongodb from "@fastify/mongodb";

export default fastifyPlugin(async function (fastify) {
  const mongoUri = process.env.CLOUD_DB
  await fastify.register(mongodb, {
    forceClose: true,
    url: mongoUri,
    database: "labpilot",
  });

  fastify.log.info('MongoDB connected');
});

