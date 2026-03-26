import toObjectId from "../../utils/db.js";

// JSON Schemas
const OID = {
  type: "string",
  minLength: 24,
  maxLength: 24,
  pattern: "^[a-fA-F0-9]{24}$",
};

const createCategoryBody = {
  type: "object",
  required: ["name"],
  properties: {
    name: { type: "string", minLength: 1 },
  },
  additionalProperties: false,
};

const updateCategoryBody = {
  type: "object",
  properties: {
    name: { type: "string", minLength: 1 },
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

// ─── Route Schemas ────────────────────────────────────────────────────────────

const listCategoriesSchema = {
  schema: {
    tags: ["Category"],
    summary: "List all categories",
  },
};

const getCategoryByIdSchema = {
  schema: {
    tags: ["Category"],
    summary: "Get a category by ID",
    params: idParam,
  },
};

const createCategorySchema = {
  schema: {
    tags: ["Category"],
    summary: "Create a new category",
    body: createCategoryBody,
  },
};

const updateCategorySchema = {
  schema: {
    tags: ["Category"],
    summary: "Update a category",
    params: idParam,
    body: updateCategoryBody,
  },
};

const deleteCategorySchema = {
  schema: {
    tags: ["Category"],
    summary: "Delete a category",
    params: idParam,
  },
};

// ─── Routes ───────────────────────────────────────────────────────────────────

export default async function categoryRoutes(fastify) {
  function col() {
    return fastify.mongo.db.collection("testCategories");
  }

  // GET /categories — list all
  fastify.get("/categories", listCategoriesSchema, async (request, reply) => {
    const categories = await col().find({}).toArray();
    return categories.map((c) => ({ ...c, _id: c._id.toString() }));
  });

  // GET /categories/:id — get one
  fastify.get("/categories/:id", getCategoryByIdSchema, async (request, reply) => {
    const oid = toObjectId(request.params.id);
    if (!oid) return reply.code(400).send({ message: "Invalid ID format" });

    const category = await col().findOne({ _id: oid });
    if (!category) return reply.code(404).send({ message: "Category not found" });

    return { ...category, _id: category._id.toString() };
  });

  // POST /categories — create
  fastify.post("/categories", createCategorySchema, async (request, reply) => {
    const { name } = request.body;

    const existing = await col().findOne({ name });
    if (existing) return reply.code(409).send({ message: `Category "${name}" already exists` });

    const result = await col().insertOne({ name });
    const created = await col().findOne({ _id: result.insertedId });

    return reply.code(201).send({ ...created, _id: created._id.toString() });
  });

  // PATCH /categories/:id — update
  fastify.patch("/categories/:id", updateCategorySchema, async (request, reply) => {
    const oid = toObjectId(request.params.id);
    if (!oid) return reply.code(400).send({ message: "Invalid ID format" });

    if (!request.body.name) {
      return reply.code(400).send({ message: "Nothing to update" });
    }

    const result = await col().findOneAndUpdate(
      { _id: oid },
      { $set: { name: request.body.name } },
      { returnDocument: "after" },
    );

    if (!result) return reply.code(404).send({ message: "Category not found" });

    return { ...result, _id: result._id.toString() };
  });

  // DELETE /categories/:id — delete
  fastify.delete("/categories/:id", deleteCategorySchema, async (request, reply) => {
    const oid = toObjectId(request.params.id);
    if (!oid) return reply.code(400).send({ message: "Invalid ID format" });

    const result = await col().deleteOne({ _id: oid });
    if (result.deletedCount === 0) return reply.code(404).send({ message: "Category not found" });

    return { message: "Category deleted successfully" };
  });
}
