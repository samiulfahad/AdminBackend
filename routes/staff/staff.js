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
  properties: {
    id: OID,
  },
};

const labIdParam = {
  type: "object",
  additionalProperties: false,
  properties: {
    labId: OID,
  },
};

const permissionsSchema = {
  type: "object",
  properties: {
    createInvoice: { type: "boolean" },
    editInvoice: { type: "boolean" },
    deleteInvoice: { type: "boolean" },
    cashmemo: { type: "boolean" },
    uploadReport: { type: "boolean" },
    downloadReport: { type: "boolean" },
  },
  additionalProperties: false,
};

const createStaffBody = {
  type: "object",
  required: ["name", "username", "email", "mobileNumber", "permissions"],
  properties: {
    name: { type: "string", minLength: 1, maxLength: 100 },
    username: { type: "string", minLength: 3, maxLength: 30 },
    email: { type: "string", minLength: 5, maxLength: 254 },
    mobileNumber: { type: "string", minLength: 10, maxLength: 15 },
    permissions: permissionsSchema,
    isActive: { type: "boolean" },
  },
  additionalProperties: false,
};

const updateStaffBody = {
  type: "object",
  properties: {
    name: { type: "string", minLength: 1, maxLength: 100 },
    username: { type: "string", minLength: 3, maxLength: 30 },
    email: { type: "string", minLength: 5, maxLength: 254 },
    mobileNumber: { type: "string", minLength: 10, maxLength: 15 },
    permissions: permissionsSchema,
    isActive: { type: "boolean" },
  },
  additionalProperties: false,
};

// ── Route Schemas ─────────────────────────────────────────────────────────────
const listStaffSchema = { tags: ["Staff"], summary: "List all staff of a lab", params: labIdParam };
const getStaffSchema = { tags: ["Staff"], summary: "Get a staff member by ID", params: idParam };
const createStaffSchema = {
  tags: ["Staff"],
  summary: "Create a staff member for a lab",
  params: labIdParam,
  body: createStaffBody,
};
const updateStaffSchema = { tags: ["Staff"], summary: "Update a staff member", params: idParam, body: updateStaffBody };
const activateStaffSchema = { tags: ["Staff"], summary: "Activate a staff member", params: idParam };
const deactivateStaffSchema = { tags: ["Staff"], summary: "Deactivate a staff member", params: idParam };
const deleteStaffSchema = { tags: ["Staff"], summary: "Delete a staff member", params: idParam };

// ── Routes ────────────────────────────────────────────────────────────────────
export default async function staffRoutes(fastify) {
  function col() {
    return fastify.mongo.db.collection("staff");
  }

  function labCol() {
    return fastify.mongo.db.collection("labs");
  }

  function toId(id) {
    try {
      return new ObjectId(id);
    } catch {
      return null;
    }
  }

  const normalizePermissions = (perms = {}) => ({
    createInvoice: perms.createInvoice ?? false,
    editInvoice: perms.editInvoice ?? false,
    deleteInvoice: perms.deleteInvoice ?? false,
    cashmemo: perms.cashmemo ?? false,
    uploadReport: perms.uploadReport ?? false,
    downloadReport: perms.downloadReport ?? false,
  });

  const alive = { isDeleted: { $ne: true } };

  const checkDuplicate = async (field, value, excludeId = null) => {
    const query = { [field]: value, ...alive };
    if (excludeId) query._id = { $ne: excludeId };
    return col().findOne(query, { projection: { _id: 1 } });
  };

  // GET /labs/:labId/staff — list all staff of a lab
  fastify.get("/labs/:labId/staff", { schema: listStaffSchema }, async (request, reply) => {
    const labOid = toId(request.params.labId);
    if (!labOid) return reply.code(400).send({ message: "Invalid lab ID format" });

    const lab = await labCol().findOne({ _id: labOid });
    if (!lab) return reply.code(404).send({ message: "Lab not found" });

    return col()
      .find({ labId: labOid, ...alive })
      .sort({ name: 1 })
      .toArray();
  });

  // GET /staff/:id — get one staff member
  fastify.get("/staff/:id", { schema: getStaffSchema }, async (request, reply) => {
    const oid = toId(request.params.id);
    if (!oid) return reply.code(400).send({ message: "Invalid ID format" });

    const staff = await col().findOne({ _id: oid, ...alive });
    if (!staff) return reply.code(404).send({ message: "Staff not found" });

    return staff;
  });

  // POST /labs/:labId/staff — create staff for a lab
  fastify.post("/labs/:labId/staff", { schema: createStaffSchema }, async (request, reply) => {
    const labOid = toId(request.params.labId);
    if (!labOid) return reply.code(400).send({ message: "Invalid lab ID format" });

    const lab = await labCol().findOne({ _id: labOid });
    if (!lab) return reply.code(404).send({ message: "Lab not found" });

    const { name, username, email, mobileNumber, permissions, isActive = true } = request.body;

    const normalizedEmail = email.toLowerCase().trim();
    const normalizedUsername = username.toLowerCase().trim();
    const normalizedMobile = mobileNumber.trim();
    const normalizedName = name.trim();

    if (await checkDuplicate("username", normalizedUsername)) {
      return reply.code(409).send({ message: `Username "${normalizedUsername}" already exists` });
    }
    if (await checkDuplicate("email", normalizedEmail)) {
      return reply.code(409).send({ message: `Email "${normalizedEmail}" already exists` });
    }
    if (await checkDuplicate("mobileNumber", normalizedMobile)) {
      return reply.code(409).send({ message: `Mobile number "${normalizedMobile}" already exists` });
    }

    const result = await col().insertOne({
      labId: labOid,
      name: normalizedName,
      username: normalizedUsername,
      email: normalizedEmail,
      mobileNumber: normalizedMobile,
      permissions: normalizePermissions(permissions),
      isActive,
      isDeleted: false,
    });

    const created = await col().findOne({ _id: result.insertedId });
    return reply.code(201).send(created);
  });

  // PATCH /staff/:id — update staff
  fastify.patch("/staff/:id", { schema: updateStaffSchema }, async (request, reply) => {
    const oid = toId(request.params.id);
    if (!oid) return reply.code(400).send({ message: "Invalid ID format" });

    const { name, username, email, mobileNumber, permissions, isActive } = request.body;
    const updates = {};

    if (name) updates.name = name.trim();

    if (username) {
      const normalized = username.toLowerCase().trim();
      if (await checkDuplicate("username", normalized, oid)) {
        return reply.code(409).send({ message: `Username "${normalized}" already exists` });
      }
      updates.username = normalized;
    }

    if (email) {
      const normalized = email.toLowerCase().trim();
      if (await checkDuplicate("email", normalized, oid)) {
        return reply.code(409).send({ message: `Email "${normalized}" already exists` });
      }
      updates.email = normalized;
    }

    if (mobileNumber) {
      const normalized = mobileNumber.trim();
      if (await checkDuplicate("mobileNumber", normalized, oid)) {
        return reply.code(409).send({ message: `Mobile number "${normalized}" already exists` });
      }
      updates.mobileNumber = normalized;
    }

    if (permissions) updates.permissions = normalizePermissions(permissions);
    if (isActive !== undefined) updates.isActive = isActive;

    if (Object.keys(updates).length === 0) {
      return reply.code(400).send({ message: "Nothing to update" });
    }

    const result = await col().findOneAndUpdate({ _id: oid, ...alive }, { $set: updates }, { returnDocument: "after" });

    if (!result) return reply.code(404).send({ message: "Staff not found" });

    return result;
  });

  // PATCH /staff/:id/activate
  fastify.patch("/staff/:id/activate", { schema: activateStaffSchema }, async (request, reply) => {
    const oid = toId(request.params.id);
    if (!oid) return reply.code(400).send({ message: "Invalid ID format" });

    const result = await col().findOneAndUpdate(
      { _id: oid, ...alive },
      { $set: { isActive: true } },
      { returnDocument: "after" },
    );

    if (!result) return reply.code(404).send({ message: "Staff not found" });

    return result;
  });

  // PATCH /staff/:id/deactivate
  fastify.patch("/staff/:id/deactivate", { schema: deactivateStaffSchema }, async (request, reply) => {
    const oid = toId(request.params.id);
    if (!oid) return reply.code(400).send({ message: "Invalid ID format" });

    const result = await col().findOneAndUpdate(
      { _id: oid, ...alive },
      { $set: { isActive: false } },
      { returnDocument: "after" },
    );

    if (!result) return reply.code(404).send({ message: "Staff not found" });

    return result;
  });

  // DELETE /staff/:id — soft delete
  fastify.delete("/staff/:id", { schema: deleteStaffSchema }, async (request, reply) => {
    const oid = toId(request.params.id);
    if (!oid) return reply.code(400).send({ message: "Invalid ID format" });

    const result = await col().findOneAndUpdate(
      { _id: oid, ...alive },
      { $set: { isDeleted: true, isActive: false } },
      { returnDocument: "after" },
    );

    if (!result) return reply.code(404).send({ message: "Staff not found" });

    return { message: "Staff deleted successfully" };
  });
}
