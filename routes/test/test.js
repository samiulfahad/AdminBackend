import { ObjectId } from "@fastify/mongodb";

// ── JSON Schemas ──────────────────────────────────────────────────────────────
const OID = {
  type: "string",
  minLength: 24,
  maxLength: 24,
  pattern: "^[a-fA-F0-9]{24}$",
};

const OID_NULLABLE = {
  type: ["string", "null"],
  minLength: 24,
  maxLength: 24,
  pattern: "^[a-fA-F0-9]{24}$",
};

const idParam = {
  type: "object",
  additionalProperties: false,
  properties: {
    id: OID,
  },
};

const createTestBody = {
  type: "object",
  required: ["name", "categoryId"],
  properties: {
    name: { type: "string", minLength: 1 },
    categoryId: OID,
    schemaId: OID_NULLABLE,
  },
  additionalProperties: false,
};

const updateTestBody = {
  type: "object",
  properties: {
    name: { type: "string", minLength: 1 },
    categoryId: OID,
    schemaId: OID_NULLABLE,
  },
  additionalProperties: false,
};

const updateSchemaIdBody = {
  type: "object",
  required: ["schemaId"],
  properties: {
    schemaId: OID_NULLABLE,
  },
  additionalProperties: false,
};

const listTestsQuery = {
  type: "object",
  properties: {
    categoryId: { type: "string" },
  },
};

// ── Route Schemas ─────────────────────────────────────────────────────────────
const listTestsSchema = {
  tags: ["Test"],
  summary: "List all tests",
  querystring: listTestsQuery,
};

const getTestSchema = {
  tags: ["Test"],
  summary: "Get a test by ID",
  params: idParam,
};

const createTestSchema = {
  tags: ["Test"],
  summary: "Create a new test",
  body: createTestBody,
};

const updateTestSchema = {
  tags: ["Test"],
  summary: "Update a test",
  params: idParam,
  body: updateTestBody,
};

const updateSchemaIdSchema = {
  tags: ["Test"],
  summary: "Update schemaId of a test",
  params: idParam,
  body: updateSchemaIdBody,
};

const deleteTestSchema = {
  tags: ["Test"],
  summary: "Delete a test",
  params: idParam,
};

// ── Routes ────────────────────────────────────────────────────────────────────
export default async function testRoutes(fastify) {
  function col() {
    return fastify.mongo.db.collection("testCatalog");
  }

  function categoryCol() {
    return fastify.mongo.db.collection("testCategories");
  }

  function toId(id) {
    try {
      return new ObjectId(id);
    } catch {
      return null;
    }
  }

  function serialize(doc) {
    return {
      ...doc,
      _id: doc._id.toString(),
      categoryId: doc.categoryId instanceof ObjectId ? doc.categoryId.toString() : (doc.categoryId ?? null),
      schemaId: doc.schemaId instanceof ObjectId ? doc.schemaId.toString() : (doc.schemaId ?? null),
    };
  }

  // GET /test/all — list all (optionally filter by categoryId)
  fastify.get("/test/all", { schema: listTestsSchema }, async (request, reply) => {
    const filter = {};

    if (request.query.categoryId) {
      const oid = toId(request.query.categoryId);
      if (!oid) return reply.code(400).send({ message: "Invalid categoryId format" });
      filter.categoryId = oid;
    }

    const tests = await col().find(filter).toArray();
    return tests.map(serialize);
  });

  // GET /test/:id — get one
  fastify.get("/test/:id", { schema: getTestSchema }, async (request, reply) => {
    const oid = toId(request.params.id);
    if (!oid) return reply.code(400).send({ message: "Invalid ID format" });

    const test = await col().findOne({ _id: oid });
    if (!test) return reply.code(404).send({ message: "Test not found" });

    return serialize(test);
  });

  // POST /test — create
  fastify.post("/test", { schema: createTestSchema }, async (request, reply) => {
    const { name, categoryId, schemaId } = request.body;

    const catOid = toId(categoryId);
    if (!catOid) return reply.code(400).send({ message: "Invalid categoryId format" });

    const category = await categoryCol().findOne({ _id: catOid });
    if (!category) return reply.code(422).send({ message: `Category "${categoryId}" does not exist` });

    const doc = {
      name,
      categoryId: catOid,
      schemaId: schemaId ? toId(schemaId) : null,
    };

    const result = await col().insertOne(doc);
    const created = await col().findOne({ _id: result.insertedId });

    return reply.code(201).send(serialize(created));
  });

  // PATCH /test/:id — update
  fastify.patch("/test/:id", { schema: updateTestSchema }, async (request, reply) => {
    const oid = toId(request.params.id);
    if (!oid) return reply.code(400).send({ message: "Invalid ID format" });

    const { name, categoryId, schemaId } = request.body;
    const updates = {};

    if (name) updates.name = name;

    if (categoryId !== undefined) {
      const catOid = toId(categoryId);
      if (!catOid) return reply.code(400).send({ message: "Invalid categoryId format" });

      const category = await categoryCol().findOne({ _id: catOid });
      if (!category) return reply.code(422).send({ message: `Category "${categoryId}" does not exist` });

      updates.categoryId = catOid;
    }

    if (schemaId !== undefined) {
      updates.schemaId = schemaId ? toId(schemaId) : null;
    }

    if (Object.keys(updates).length === 0) {
      return reply.code(400).send({ message: "Nothing to update" });
    }

    const result = await col().findOneAndUpdate({ _id: oid }, { $set: updates }, { returnDocument: "after" });

    if (!result) return reply.code(404).send({ message: "Test not found" });

    return serialize(result);
  });

  // PATCH /test/:id/schema — update schemaId only
  fastify.patch("/test/:id/schema", { schema: updateSchemaIdSchema }, async (request, reply) => {
    const oid = toId(request.params.id);
    if (!oid) return reply.code(400).send({ message: "Invalid ID format" });

    const { schemaId } = request.body;

    const result = await col().findOneAndUpdate(
      { _id: oid },
      { $set: { schemaId: schemaId ? toId(schemaId) : null } },
      { returnDocument: "after" },
    );

    if (!result) return reply.code(404).send({ message: "Test not found" });

    return serialize(result);
  });

  // DELETE /test/:id — delete
  fastify.delete("/test/:id", { schema: deleteTestSchema }, async (request, reply) => {
    const oid = toId(request.params.id);
    if (!oid) return reply.code(400).send({ message: "Invalid ID format" });

    const result = await col().deleteOne({ _id: oid });
    if (result.deletedCount === 0) return reply.code(404).send({ message: "Test not found" });

    return { message: "Test deleted successfully" };
  });
}
