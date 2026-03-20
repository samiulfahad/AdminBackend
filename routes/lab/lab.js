import { ObjectId } from "@fastify/mongodb";

// ── JSON Schemas ──────────────────────────────────────────────────────────────
const OID = {
  type: "string",
  minLength: 24,
  maxLength: 24,
  pattern: "^[a-fA-F0-9]{24}$",
};

const idParam = {
  type: "object",
  additionalProperties: false,
  properties: { id: OID },
};

const paginationQuery = {
  type: "object",
  properties: {
    page: { type: "integer", minimum: 1, default: 1 },
    limit: { type: "integer", minimum: 1, maximum: 100, default: 10 },
    labID: { type: "string" },
  },
};

const contactSchema = {
  type: "object",
  properties: {
    primary: { type: "string" },
    secondary: { type: "string" },
    publicEmail: { type: "string", format: "email" },
    privateEmail: { type: "string", format: "email" },
    address: { type: "string" },
    district: { type: "string" },
    zone: { type: "string" },
  },
  additionalProperties: false,
};

const billingSchema = {
  type: "object",
  properties: {
    perInvoiceFee: { type: "number", minimum: 0 },
    monthlyFee: { type: "number", minimum: 0 },
    commission: { type: "number", minimum: 0 },
  },
  additionalProperties: false,
};

const createLabBody = {
  type: "object",
  required: ["name", "labID", "contact", "billing"],
  properties: {
    name: { type: "string", minLength: 1 },
    labID: { type: "string", minLength: 5, maxLength: 5, pattern: "^[0-9]{5}$" },
    contact: contactSchema,
    billing: billingSchema,
    isActive: { type: "boolean", default: true },
  },
  additionalProperties: false,
};

// labID is intentionally absent — it cannot be changed after creation
const updateLabBody = {
  type: "object",
  properties: { name: { type: "string", minLength: 1 } },
  additionalProperties: false,
};

const updateContactBody = {
  type: "object",
  required: ["contact"],
  properties: { contact: contactSchema },
  additionalProperties: false,
};

const updateBillingBody = {
  type: "object",
  required: ["billing"],
  properties: { billing: billingSchema },
  additionalProperties: false,
};

// ── Route Schemas ─────────────────────────────────────────────────────────────
const listLabsSchema = {
  tags: ["Lab"],
  summary: "List labs (paginated, search by labID)",
  querystring: paginationQuery,
};
const getLabSchema = { tags: ["Lab"], summary: "Get a lab by ID", params: idParam };
const createLabSchema = { tags: ["Lab"], summary: "Create a new lab", body: createLabBody };
const updateLabSchema = { tags: ["Lab"], summary: "Update lab name", params: idParam, body: updateLabBody };
const updateContactSchema = { tags: ["Lab"], summary: "Update lab contact", params: idParam, body: updateContactBody };
const updateBillingSchema = { tags: ["Lab"], summary: "Update lab billing", params: idParam, body: updateBillingBody };
const activateLabSchema = { tags: ["Lab"], summary: "Activate a lab", params: idParam };
const deactivateLabSchema = { tags: ["Lab"], summary: "Deactivate a lab", params: idParam };
const deleteLabSchema = { tags: ["Lab"], summary: "Delete a lab", params: idParam };

// ── Routes ────────────────────────────────────────────────────────────────────
export default async function labRoutes(fastify) {
  function col() {
    return fastify.mongo.db.collection("labs");
  }

  function toId(id) {
    try {
      return new ObjectId(id);
    } catch {
      return null;
    }
  }

  // GET /labs/all
  fastify.get("/labs/all", { schema: listLabsSchema }, async (request) => {
    const page = request.query.page ?? 1;
    const limit = request.query.limit ?? 10;
    const skip = (page - 1) * limit;
    const labID = request.query.labID?.trim();

    const filter = labID ? { labID: { $regex: labID, $options: "i" } } : {};

    const [data, total] = await Promise.all([
      col().find(filter).skip(skip).limit(limit).toArray(),
      col().countDocuments(filter),
    ]);

    return { data, total, page, limit, totalPages: Math.ceil(total / limit) };
  });

  // GET /labs/:id
  fastify.get("/labs/:id", { schema: getLabSchema }, async (request, reply) => {
    const oid = toId(request.params.id);
    if (!oid) return reply.code(400).send({ message: "Invalid ID format" });
    const lab = await col().findOne({ _id: oid });
    if (!lab) return reply.code(404).send({ message: "Lab not found" });
    return lab;
  });

  // POST /labs
  fastify.post("/labs", { schema: createLabSchema }, async (request, reply) => {
    const { name, labID, contact, billing, isActive = true } = request.body;
    const existing = await col().findOne({ labID });
    if (existing) return reply.code(409).send({ message: `Lab ID "${labID}" already exists` });
    const result = await col().insertOne({ name, labID, contact, billing, isActive });
    const created = await col().findOne({ _id: result.insertedId });
    return reply.code(201).send(created);
  });

  // PATCH /labs/:id — only name is mutable; labID is never touched
  fastify.patch("/labs/:id", { schema: updateLabSchema }, async (request, reply) => {
    const oid = toId(request.params.id);
    if (!oid) return reply.code(400).send({ message: "Invalid ID format" });
    if (!request.body.name) return reply.code(400).send({ message: "Nothing to update" });

    // Explicitly $set only `name` — labID is never included, even if somehow
    // passed by a rogue client (additionalProperties: false in the schema
    // already rejects unknown fields at the Fastify validation layer).
    const result = await col().findOneAndUpdate(
      { _id: oid },
      { $set: { name: request.body.name } },
      { returnDocument: "after" },
    );
    if (!result) return reply.code(404).send({ message: "Lab not found" });
    return result;
  });

  // PATCH /labs/:id/contact
  fastify.patch("/labs/:id/contact", { schema: updateContactSchema }, async (request, reply) => {
    const oid = toId(request.params.id);
    if (!oid) return reply.code(400).send({ message: "Invalid ID format" });
    const result = await col().findOneAndUpdate(
      { _id: oid },
      { $set: { contact: request.body.contact } },
      { returnDocument: "after" },
    );
    if (!result) return reply.code(404).send({ message: "Lab not found" });
    return result;
  });

  // PATCH /labs/:id/billing
  fastify.patch("/labs/:id/billing", { schema: updateBillingSchema }, async (request, reply) => {
    const oid = toId(request.params.id);
    if (!oid) return reply.code(400).send({ message: "Invalid ID format" });
    const result = await col().findOneAndUpdate(
      { _id: oid },
      { $set: { billing: request.body.billing } },
      { returnDocument: "after" },
    );
    if (!result) return reply.code(404).send({ message: "Lab not found" });
    return result;
  });

  // PATCH /labs/:id/activate
  fastify.patch("/labs/:id/activate", { schema: activateLabSchema }, async (request, reply) => {
    const oid = toId(request.params.id);
    if (!oid) return reply.code(400).send({ message: "Invalid ID format" });
    const result = await col().findOneAndUpdate(
      { _id: oid },
      { $set: { isActive: true } },
      { returnDocument: "after" },
    );
    if (!result) return reply.code(404).send({ message: "Lab not found" });
    return result;
  });

  // PATCH /labs/:id/deactivate
  fastify.patch("/labs/:id/deactivate", { schema: deactivateLabSchema }, async (request, reply) => {
    const oid = toId(request.params.id);
    if (!oid) return reply.code(400).send({ message: "Invalid ID format" });
    const result = await col().findOneAndUpdate(
      { _id: oid },
      { $set: { isActive: false } },
      { returnDocument: "after" },
    );
    if (!result) return reply.code(404).send({ message: "Lab not found" });
    return result;
  });

  // DELETE /labs/:id
  fastify.delete("/labs/:id", { schema: deleteLabSchema }, async (request, reply) => {
    const oid = toId(request.params.id);
    if (!oid) return reply.code(400).send({ message: "Invalid ID format" });
    const result = await col().deleteOne({ _id: oid });
    if (result.deletedCount === 0) return reply.code(404).send({ message: "Lab not found" });
    return { message: "Lab deleted successfully" };
  });
}
