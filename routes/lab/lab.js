import toObjectId from "../../utils/db.js";

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
    labKey: { type: "string" },
    zoneId: OID, // ← validated as OID string
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
    zoneId: OID, // ← validated as OID string (converted to ObjectId before save)
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
  required: ["name", "labKey", "contact", "billing"],
  properties: {
    name: { type: "string", minLength: 1 },
    labKey: { type: "string", minLength: 5, maxLength: 5, pattern: "^[0-9]{5}$" },
    contact: contactSchema,
    billing: billingSchema,
    isActive: { type: "boolean", default: true },
  },
  additionalProperties: false,
};

const updateLabBody = {
  type: "object",
  properties: { name: { type: "string", minLength: 1 } },
  additionalProperties: false,
};

const updateInfoBody = {
  type: "object",
  properties: {
    name: { type: "string", minLength: 1 },
    contact: contactSchema,
  },
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

// ── Helper ────────────────────────────────────────────────────────────────────
// Converts contact.zoneId string → ObjectId (mutates a shallow copy)
function normalizeContact(contact) {
  if (!contact) return contact;
  const c = { ...contact };
  if (c.zoneId) {
    const oid = toObjectId(c.zoneId);
    if (!oid) throw { statusCode: 400, message: "Invalid zoneId format" };
    c.zoneId = oid; // ← stored as ObjectId
  }
  return c;
}

// ── Route Schemas ─────────────────────────────────────────────────────────────
const listLabsSchema = {
  tags: ["Lab"],
  summary: "List labs (paginated, search by labKey)",
  querystring: paginationQuery,
};
const statsLabSchema = { tags: ["Lab"], summary: "Get lab stats (total, active, inactive, revenue)" };
const getLabSchema = { tags: ["Lab"], summary: "Get a lab by ID", params: idParam };
const createLabSchema = { tags: ["Lab"], summary: "Create a new lab", body: createLabBody };
const updateLabSchema = { tags: ["Lab"], summary: "Update lab name", params: idParam, body: updateLabBody };
const updateInfoSchema = {
  tags: ["Lab"],
  summary: "Update lab name and contact",
  params: idParam,
  body: updateInfoBody,
};
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

  // GET /labs/stats
  fastify.get("/labs/stats", { schema: statsLabSchema }, async () => {
    const [result] = await col()
      .aggregate([
        {
          $group: {
            _id: null,
            total: { $sum: 1 },
            active: { $sum: { $cond: ["$isActive", 1, 0] } },
            inactive: { $sum: { $cond: ["$isActive", 0, 1] } },
            totalMonthly: { $sum: { $ifNull: ["$billing.monthlyFee", 0] } },
            totalInvoice: { $sum: { $ifNull: ["$billing.perInvoiceFee", 0] } },
          },
        },
      ])
      .toArray();

    return result
      ? {
          total: result.total,
          active: result.active,
          inactive: result.inactive,
          totalMonthly: result.totalMonthly,
          totalInvoice: result.totalInvoice,
        }
      : { total: 0, active: 0, inactive: 0, totalMonthly: 0, totalInvoice: 0 };
  });

  // GET /labs/all
  fastify.get("/labs/all", { schema: listLabsSchema }, async (request) => {
    const page = request.query.page ?? 1;
    const limit = request.query.limit ?? 10;
    const skip = (page - 1) * limit;
    const labKey = request.query.labKey?.trim();

    const filter = {};
    if (labKey) filter.labKey = { $regex: labKey, $options: "i" };
    if (request.query.zoneId) {
      const zoneOid = toObjectId(request.query.zoneId); // ← query as ObjectId
      if (!zoneOid) return reply.code(400).send({ message: "Invalid zoneId format" });
      filter["contact.zoneId"] = zoneOid;
    }

    const [data, total] = await Promise.all([
      col().find(filter).skip(skip).limit(limit).sort({ createdAt: -1 }).toArray(),
      col().countDocuments(filter),
    ]);

    return { data, total, page, limit, totalPages: Math.ceil(total / limit) };
  });

  // GET /labs/:id
  fastify.get("/labs/:id", { schema: getLabSchema }, async (request, reply) => {
    const oid = toObjectId(request.params.id);
    if (!oid) return reply.code(400).send({ message: "Invalid ID format" });
    const lab = await col().findOne({ _id: oid });
    if (!lab) return reply.code(404).send({ message: "Lab not found" });
    return lab;
  });

  // POST /labs
  fastify.post("/labs", { schema: createLabSchema }, async (request, reply) => {
    const { name, labKey, billing, isActive = true } = request.body;

    let contact;
    try {
      contact = normalizeContact(request.body.contact);
    } catch (e) {
      // ← zoneId → ObjectId
      return reply.code(400).send({ message: e.message });
    }

    const existing = await col().findOne({ labKey });
    if (existing) return reply.code(409).send({ message: `Lab ID "${labKey}" already exists` });

    const result = await col().insertOne({ name, labKey, contact, billing, isActive, createdAt: new Date() });
    const created = await col().findOne({ _id: result.insertedId });
    return reply.code(201).send(created);
  });

  // PATCH /labs/:id — name only
  fastify.patch("/labs/:id", { schema: updateLabSchema }, async (request, reply) => {
    const oid = toObjectId(request.params.id);
    if (!oid) return reply.code(400).send({ message: "Invalid ID format" });
    if (!request.body.name) return reply.code(400).send({ message: "Nothing to update" });
    const result = await col().findOneAndUpdate(
      { _id: oid },
      { $set: { name: request.body.name } },
      { returnDocument: "after" },
    );
    if (!result) return reply.code(404).send({ message: "Lab not found" });
    return result;
  });

  // PATCH /labs/:id/info — name + full contact
  fastify.patch("/labs/:id/info", { schema: updateInfoSchema }, async (request, reply) => {
    const oid = toObjectId(request.params.id);
    if (!oid) return reply.code(400).send({ message: "Invalid ID format" });

    const $set = {};
    if (request.body.name) $set.name = request.body.name;
    if (request.body.contact) {
      try {
        $set.contact = normalizeContact(request.body.contact);
      } catch (e) {
        // ← zoneId → ObjectId
        return reply.code(400).send({ message: e.message });
      }
    }

    if (!Object.keys($set).length) return reply.code(400).send({ message: "Nothing to update" });

    const result = await col().findOneAndUpdate({ _id: oid }, { $set }, { returnDocument: "after" });
    if (!result) return reply.code(404).send({ message: "Lab not found" });
    return result;
  });

  // PATCH /labs/:id/contact
  fastify.patch("/labs/:id/contact", { schema: updateContactSchema }, async (request, reply) => {
    const oid = toObjectId(request.params.id);
    if (!oid) return reply.code(400).send({ message: "Invalid ID format" });

    let contact;
    try {
      contact = normalizeContact(request.body.contact);
    } catch (e) {
      // ← zoneId → ObjectId
      return reply.code(400).send({ message: e.message });
    }

    const result = await col().findOneAndUpdate({ _id: oid }, { $set: { contact } }, { returnDocument: "after" });
    if (!result) return reply.code(404).send({ message: "Lab not found" });
    return result;
  });

  // PATCH /labs/:id/billing
  fastify.patch("/labs/:id/billing", { schema: updateBillingSchema }, async (request, reply) => {
    const oid = toObjectId(request.params.id);
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
    const oid = toObjectId(request.params.id);
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
    const oid = toObjectId(request.params.id);
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
    const oid = toObjectId(request.params.id);
    if (!oid) return reply.code(400).send({ message: "Invalid ID format" });
    const result = await col().deleteOne({ _id: oid });
    if (result.deletedCount === 0) return reply.code(404).send({ message: "Lab not found" });
    return { message: "Lab deleted successfully" };
  });
}
