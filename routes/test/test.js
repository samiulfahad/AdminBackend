import toObjectId from "../../utils/db.js";

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
  properties: { id: OID },
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
  properties: { schemaId: OID_NULLABLE },
  additionalProperties: false,
};

const listTestsQuery = {
  type: "object",
  properties: { categoryId: { type: "string" } },
};

const listTestsSchema = { tags: ["Test"], summary: "List all tests", querystring: listTestsQuery };
const getTestSchema = { tags: ["Test"], summary: "Get a test by ID", params: idParam };
const createTestSchema = { tags: ["Test"], summary: "Create a new test", body: createTestBody };
const updateTestSchema = { tags: ["Test"], summary: "Update a test", params: idParam, body: updateTestBody };
const updateSchemaIdSchema = {
  tags: ["Test"],
  summary: "Update schemaId of a test",
  params: idParam,
  body: updateSchemaIdBody,
};
const deleteTestSchema = { tags: ["Test"], summary: "Delete a test", params: idParam };

export default async function testRoutes(fastify) {
  function col() {
    return fastify.mongo.db.collection("testCatalog");
  }

  function categoryCol() {
    return fastify.mongo.db.collection("testCategories");
  }

  // GET /test/all
  fastify.get("/test/all", { schema: listTestsSchema }, async (request) => {
    const filter = {};

    if (request.query.categoryId) {
      filter.categoryId = request.query.categoryId; // ← fixed + simplified (string)
    }

    return col().find(filter).toArray();
  });

  // GET /test/:id
  fastify.get("/test/:id", { schema: getTestSchema }, async (request, reply) => {
    const id = toObjectId(request.params.id);
    if (!id) return reply.code(400).send({ message: "Invalid ID format" });

    const test = await col().findOne({ _id: id });
    if (!test) return reply.code(404).send({ message: "Test not found" });

    return test;
  });

  // POST /test
  fastify.post("/test", { schema: createTestSchema }, async (request, reply) => {
    const { name, categoryId, schemaId } = request.body;

    // category existence check (still needs ObjectId because category collection uses _id as ObjectId)
    const category = await categoryCol().findOne({ _id: toObjectId(categoryId) });
    if (!category) return reply.code(422).send({ message: `Category "${categoryId}" does not exist` });

    const result = await col().insertOne({
      name,
      categoryId, // ← stored as string
      schemaId: schemaId ?? null, // cleaner than ternary
    });

    const created = await col().findOne({ _id: result.insertedId });
    return reply.code(201).send(created);
  });

  // PATCH /test/:id
  fastify.patch("/test/:id", { schema: updateTestSchema }, async (request, reply) => {
    const id = toObjectId(request.params.id);
    if (!id) return reply.code(400).send({ message: "Invalid ID format" });

    const { name, categoryId, schemaId } = request.body;
    const updates = {};

    if (name) updates.name = name;

    if (categoryId !== undefined) {
      const catId = toObjectId(categoryId);
      if (!catId) return reply.code(400).send({ message: "Invalid categoryId format" });

      const category = await categoryCol().findOne({ _id: catId });
      if (!category) return reply.code(422).send({ message: `Category "${categoryId}" does not exist` });

      updates.categoryId = categoryId; // ← stored as string
    }

    if (schemaId !== undefined) {
      updates.schemaId = schemaId ?? null;
    }

    if (Object.keys(updates).length === 0) {
      return reply.code(400).send({ message: "Nothing to update" });
    }

    const result = await col().findOneAndUpdate({ _id: id }, { $set: updates }, { returnDocument: "after" });

    if (!result) return reply.code(404).send({ message: "Test not found" });
    return result;
  });

  // PATCH /test/:id/schema
  fastify.patch("/test/:id/schema", { schema: updateSchemaIdSchema }, async (request, reply) => {
    const id = toObjectId(request.params.id);
    if (!id) return reply.code(400).send({ message: "Invalid ID format" });

    const result = await col().findOneAndUpdate(
      { _id: id },
      { $set: { schemaId: request.body.schemaId ?? null } },
      { returnDocument: "after" },
    );

    if (!result) return reply.code(404).send({ message: "Test not found" });
    return result;
  });

  // DELETE /test/:id
  fastify.delete("/test/:id", { schema: deleteTestSchema }, async (request, reply) => {
    const id = toObjectId(request.params.id);
    if (!id) return reply.code(400).send({ message: "Invalid ID format" });

    const result = await col().deleteOne({ _id: id });
    if (result.deletedCount === 0) return reply.code(404).send({ message: "Test not found" });

    return { message: "Test deleted successfully" };
  });
}
