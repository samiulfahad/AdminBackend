import fastifyPlugin from "fastify-plugin";
import mongodb from "@fastify/mongodb";

export default fastifyPlugin(async function (fastify) {
  // const mongoUri = process.env.MONGODB_URI
  const mongoUri = "mongodb+srv://dbAdmin:dbAdminPass@labpilot.heko8il.mongodb.net/?appName=LabPilot";
  await fastify.register(mongodb, {
    forceClose: true,
    url: mongoUri,
    database: "labpilot",
  });

  fastify.log.info('MongoDB connected');
});
