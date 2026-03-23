import { ObjectId } from "@fastify/mongodb";

export default async function demoReportRoutes(fastify) {
  function col() {
    return fastify.mongo.db.collection("demoReports");
  }

  function toId(id) {
    try {
      return new ObjectId(id);
    } catch {
      return null;
    }
  }

  // GET /demo-report/:id
  fastify.get("/demo-report/:id", async (req, reply) => {
    const oid = toId(req.params.id);
    if (!oid) return reply.code(400).send({ message: "Invalid ID format" });

    const doc = await col().findOne({ _id: oid });
    if (!doc) return reply.code(404).send({ message: "Report not found" });

    return doc;
  });

  // POST /demo-report
  // If a report for the same schemaId already exists, replace it. Otherwise insert.
  fastify.post("/demo-report", async (req, reply) => {
    const body = req.body ?? {};

    if (!body.schemaId) {
      return reply.code(400).send({ message: "schemaId is required" });
    }

    const result = await col().findOneAndUpdate(
      { schemaId: body.schemaId },
      { $set: body },
      { upsert: true, returnDocument: "after" },
    );

    return reply.code(200).send(result);
  });

  // DELETE /demo-report/:id
  fastify.delete("/demo-report/:id", async (req, reply) => {
    const oid = toId(req.params.id);
    if (!oid) return reply.code(400).send({ message: "Invalid ID format" });

    const result = await col().deleteOne({ _id: oid });
    if (result.deletedCount === 0) return reply.code(404).send({ message: "Report not found" });

    return { message: "Report deleted successfully" };
  });
}
