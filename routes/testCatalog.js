import { ObjectId } from "@fastify/mongodb";

// JSON Schemas
const OID = { type: "string", pattern: "^[a-fA-F0-9]{24}$" };
const OID_NULLABLE = { type: ["string", "null"], pattern: "^[a-fA-F0-9]{24}$" };

const testCatalogSchema = {
  type: "object",
  properties: {
    _id: OID,
    name: { type: "string" },
    categoryId: OID,
    schemaId: OID_NULLABLE,
  },
};

const createTestCatalogBody = {
  type: "object",
  required: ["name", "categoryId"],
  properties: {
    name: { type: "string", minLength: 1 },
    categoryId: OID,
    schemaId: OID_NULLABLE,
  },
  additionalProperties: false,
};

const updateTestCatalogBody = {
  type: "object",
  properties: {
    name: { type: "string", minLength: 1 },
    categoryId: OID,
    schemaId: OID_NULLABLE,
  },
  additionalProperties: false,
};

const idParam = {
  type: "object",
  additionalProperties: false,
  properties: {
    id: OID,
  },
};

export default async function testCatalogRoutes(fastify) {
  const DB_NAME = "testCatalog";
  const COLLECTION = "testCatalog";

  function col() {
    return fastify.mongo.client.db(DB_NAME).collection(COLLECTION);
  }

  function categoryCol() {
    return fastify.mongo.client.db("category").collection("categories");
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

  // GET /catalogs — list all (optionally filter by categoryId)
  fastify.get(
    "/testCatalogs",
    {
      schema: {
        tags: ["TestCatalog"],
        summary: "List all testCatalogs",
        querystring: {
          type: "object",
          properties: {
            categoryId: { type: "string" },
          },
        },
        response: {
          200: { type: "array", items: testCatalogSchema },
        },
      },
    },
    async (request, reply) => {
      const filter = {};

      if (request.query.categoryId) {
        const oid = toId(request.query.categoryId);
        if (!oid) return reply.code(400).send({ message: "Invalid categoryId format" });
        filter.categoryId = oid;
      }

      const testCatalogs = await col().find(filter).toArray();
      return testCatalogs.map(serialize);
    },
  );

  // GET /catalogs/:id — get one
  fastify.get(
    "/testCatalogs/:id",
    {
      schema: {
        tags: ["TestCatalog"],
        summary: "Get a testCatalog by ID",
        params: idParam,
        response: {
          200: testCatalogSchema,
          404: { type: "object", properties: { message: { type: "string" } } },
        },
      },
    },
    async (request, reply) => {
      const oid = toId(request.params.id);
      if (!oid) return reply.code(400).send({ message: "Invalid ID format" });

      const testCatalog = await col().findOne({ _id: oid });
      if (!testCatalog) return reply.code(404).send({ message: "TestCatalog not found" });

      return serialize(testCatalog);
    },
  );

  // POST /catalogs — create
  fastify.post(
    "/testCatalogs",
    {
      schema: {
        tags: ["TestCatalog"],
        summary: "Create a new testCatalog",
        body: createTestCatalogBody,
        response: { 201: testCatalogSchema },
      },
    },
    async (request, reply) => {
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
    },
  );

  // PATCH /catalogs/:id — update
  fastify.patch(
    "/testCatalogs/:id",
    {
      schema: {
        tags: ["TestCatalog"],
        summary: "Update a testCatalog",
        params: idParam,
        body: updateTestCatalogBody,
        response: {
          200: testCatalogSchema,
          404: { type: "object", properties: { message: { type: "string" } } },
        },
      },
    },
    async (request, reply) => {
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

      if (!result) return reply.code(404).send({ message: "TestCatalog not found" });

      return serialize(result);
    },
  );

  // DELETE /catalogs/:id — delete
  fastify.delete(
    "/testCatalogs/:id",
    {
      schema: {
        tags: ["TestCatalog"],
        summary: "Delete a testCatalog",
        params: idParam,
        response: {
          200: { type: "object", properties: { message: { type: "string" } } },
          404: { type: "object", properties: { message: { type: "string" } } },
        },
      },
    },
    async (request, reply) => {
      const oid = toId(request.params.id);
      if (!oid) return reply.code(400).send({ message: "Invalid ID format" });

      const result = await col().deleteOne({ _id: oid });
      if (result.deletedCount === 0) return reply.code(404).send({ message: "TestCatalog not found" });

      return { message: "TestCatalog deleted successfully" };
    },
  );
}
