import { ObjectId } from "@fastify/mongodb";

export default async function schemaRoutes(fastify) {
  function col() {
    return fastify.mongo.db.collection("testSchema");
  }

  function toId(id) {
    try {
      return new ObjectId(id);
    } catch {
      return null;
    }
  }

  // GET /test-schema/all
  fastify.get("/test-schema/all", async () => {
    return col().find({}).sort({ createdAt: -1 }).toArray();
  });

  // GET /test-schema/by-test/:testId
  fastify.get("/test-schema/by-test/:testId", async (request, reply) => {
    const docs = await col().find({ testId: request.params.testId }).sort({ createdAt: -1 }).toArray();
    return docs;
  });

  // GET /test-schema/:id
  fastify.get("/test-schema/:id", async (request, reply) => {
    const oid = toId(request.params.id);
    if (!oid) return reply.code(400).send({ message: "Invalid ID format" });

    const doc = await col().findOne({ _id: oid });
    if (!doc) return reply.code(404).send({ message: "Test schema not found" });

    return doc;
  });

  // POST /test-schema
  fastify.post("/test-schema", async (request, reply) => {
    const body = request.body ?? {};

    const now = new Date();
    const createdAt = now.toLocaleString("en-BD", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: true,
      day: "numeric",
      month: "long",
      year: "numeric",
    });

    const doc = {
      ...body,
      isActive: body.isActive ?? true,
      createdAt,
    };

    const result = await col().insertOne(doc);
    const created = await col().findOne({ _id: result.insertedId });
    return reply.code(201).send(created);
  });

  // PATCH /test-schema/:id
  fastify.patch("/test-schema/:id", async (request, reply) => {
    const oid = toId(request.params.id);
    if (!oid) return reply.code(400).send({ message: "Invalid ID format" });

    const { _id, createdAt, ...rest } = request.body ?? {};

    if (Object.keys(rest).length === 0) {
      return reply.code(400).send({ message: "Nothing to update" });
    }

    const result = await col().findOneAndUpdate({ _id: oid }, { $set: rest }, { returnDocument: "after" });

    if (!result) return reply.code(404).send({ message: "Test schema not found" });
    return result;
  });

  // PATCH /test-schema/:id/activate
  fastify.patch("/test-schema/:id/activate", async (request, reply) => {
    const oid = toId(request.params.id);
    if (!oid) return reply.code(400).send({ message: "Invalid ID format" });

    const result = await col().findOneAndUpdate(
      { _id: oid },
      { $set: { isActive: true } },
      { returnDocument: "after" },
    );

    if (!result) return reply.code(404).send({ message: "Test schema not found" });
    return result;
  });

  // PATCH /test-schema/:id/deactivate
  fastify.patch("/test-schema/:id/deactivate", async (request, reply) => {
    const oid = toId(request.params.id);
    if (!oid) return reply.code(400).send({ message: "Invalid ID format" });

    const result = await col().findOneAndUpdate(
      { _id: oid },
      { $set: { isActive: false } },
      { returnDocument: "after" },
    );

    if (!result) return reply.code(404).send({ message: "Test schema not found" });
    return result;
  });

  // DELETE /test-schema/:id
  fastify.delete("/test-schema/:id", async (request, reply) => {
    const oid = toId(request.params.id);
    if (!oid) return reply.code(400).send({ message: "Invalid ID format" });

    const result = await col().deleteOne({ _id: oid });
    if (result.deletedCount === 0) return reply.code(404).send({ message: "Test schema not found" });

    return { message: "Test schema deleted successfully" };
  });
}
