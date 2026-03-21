// routes/staff.js
import { ObjectId } from "@fastify/mongodb";

// ── Constants ─────────────────────────────────────────────────────────────────
const ROLES = {
  ADMIN: "admin",
  STAFF: "staff",
  SUPPORT_ADMIN: "supportAdmin",
};

// Sentinel value stored as phone for the support admin.
// Never a real phone — used to identify & guard the support admin doc.
const SUPPORT_ADMIN_PHONE = "SUPPORTADMIN";

// All permissions on (admin default) / all off (staff default — customized per person)
const ALL_PERMISSIONS_ON = {
  createInvoice: true,
  editInvoice: true,
  deleteInvoice: true,
  cashmemo: true,
  uploadReport: true,
  downloadReport: true,
};
const ALL_PERMISSIONS_OFF = {
  createInvoice: false,
  editInvoice: false,
  deleteInvoice: false,
  cashmemo: false,
  uploadReport: false,
  downloadReport: false,
};

// ── JSON Schemas ──────────────────────────────────────────────────────────────
const OID = {
  type: "string",
  minLength: 24,
  maxLength: 24,
  pattern: "^[a-fA-F0-9]{24}$",
};

const labIdParam = {
  type: "object",
  additionalProperties: false,
  properties: { labId: OID },
};

const labStaffParam = {
  type: "object",
  additionalProperties: false,
  properties: { labId: OID, id: OID },
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

// ── Create bodies ─────────────────────────────────────────────────────────────

// Admin — no permissions field (always all true)
const createAdminBody = {
  type: "object",
  required: ["name", "phone"],
  properties: {
    name: { type: "string", minLength: 1, maxLength: 100 },
    phone: { type: "string", minLength: 10, maxLength: 15 },
    email: { type: "string", format: "email" },
    isActive: { type: "boolean" },
  },
  additionalProperties: false,
};

// Staff — permissions required and fully customizable
const createStaffBody = {
  type: "object",
  required: ["name", "phone", "permissions"],
  properties: {
    name: { type: "string", minLength: 1, maxLength: 100 },
    phone: { type: "string", minLength: 10, maxLength: 15 },
    email: { type: "string", format: "email" },
    permissions: permissionsSchema,
    isActive: { type: "boolean" },
  },
  additionalProperties: false,
};

// Support admin — password only, everything else is fixed
const createSupportAdminBody = {
  type: "object",
  required: ["password"],
  properties: {
    password: { type: "string", minLength: 6 },
  },
  additionalProperties: false,
};

// ── Update body (shared — role cannot be changed after creation) ──────────────
const updateStaffBody = {
  type: "object",
  minProperties: 1,
  properties: {
    name: { type: "string", minLength: 1, maxLength: 100 },
    phone: { type: "string", minLength: 10, maxLength: 15 },
    email: { type: "string", format: "email" },
    permissions: permissionsSchema,
    isActive: { type: "boolean" },
  },
  additionalProperties: false,
};

// ── Route Schemas ─────────────────────────────────────────────────────────────
const listStaffSchema = { tags: ["Staff"], summary: "List all staff & admins of a lab", params: labIdParam };
const getStaffSchema = { tags: ["Staff"], summary: "Get a staff member by ID", params: labStaffParam };
const createAdminSchema = { tags: ["Staff"], summary: "Create a lab admin", params: labIdParam, body: createAdminBody };
const createStaffSchema = {
  tags: ["Staff"],
  summary: "Create a lab staff member",
  params: labIdParam,
  body: createStaffBody,
};
const createSupportAdminSchema = {
  tags: ["Staff"],
  summary: "Create the lab support admin",
  params: labIdParam,
  body: createSupportAdminBody,
};
const updateStaffSchema = {
  tags: ["Staff"],
  summary: "Update a staff member or admin",
  params: labStaffParam,
  body: updateStaffBody,
};
const activateStaffSchema = { tags: ["Staff"], summary: "Activate a staff member", params: labStaffParam };
const deactivateStaffSchema = { tags: ["Staff"], summary: "Deactivate a staff member", params: labStaffParam };
const deleteStaffSchema = { tags: ["Staff"], summary: "Delete a staff member", params: labStaffParam };

// ── Routes ────────────────────────────────────────────────────────────────────
export default async function staffRoutes(fastify) {
  function col() {
    return fastify.mongo.db.collection("staffs");
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

  const alive = { isDeleted: { $ne: true } };

  const normalizePermissions = (perms = {}) => ({
    createInvoice: perms.createInvoice ?? false,
    editInvoice: perms.editInvoice ?? false,
    deleteInvoice: perms.deleteInvoice ?? false,
    cashmemo: perms.cashmemo ?? false,
    uploadReport: perms.uploadReport ?? false,
    downloadReport: perms.downloadReport ?? false,
  });

  // ── Duplicate checkers (lab-scoped) ───────────────────────────────────────
  const phoneExistsInLab = async (labOid, phone, excludeId = null) => {
    const query = { labId: labOid, phone, ...alive };
    if (excludeId) query._id = { $ne: excludeId };
    return col().findOne(query, { projection: { _id: 1 } });
  };

  const emailExistsInLab = async (labOid, email, excludeId = null) => {
    const query = { labId: labOid, email, ...alive };
    if (excludeId) query._id = { $ne: excludeId };
    return col().findOne(query, { projection: { _id: 1 } });
  };

  // ── Helpers ───────────────────────────────────────────────────────────────
  const resolveLabOrFail = async (rawLabId, reply) => {
    const labOid = toId(rawLabId);
    if (!labOid) {
      reply.code(400).send({ message: "Invalid lab ID format" });
      return null;
    }
    const lab = await labCol().findOne({ _id: labOid }, { projection: { _id: 1 } });
    if (!lab) {
      reply.code(404).send({ message: "Lab not found" });
      return null;
    }
    return labOid;
  };

  const isSupportAdmin = (doc) => doc?.phone === SUPPORT_ADMIN_PHONE;

  // ── GET /labs/:labId/staff ─────────────────────────────────────────────────
  // Returns all roles except support admin (use separate route if needed)
  fastify.get("/labs/:labId/staff", { schema: listStaffSchema }, async (request, reply) => {
    const labOid = await resolveLabOrFail(request.params.labId, reply);
    if (!labOid) return;

    return col()
      .find({ labId: labOid, phone: { $ne: SUPPORT_ADMIN_PHONE }, ...alive })
      .sort({ role: 1, name: 1 }) // admins first, then staff — alphabetical within each
      .toArray();
  });

  // ── GET /labs/:labId/staff/:id ─────────────────────────────────────────────
  fastify.get("/labs/:labId/staff/:id", { schema: getStaffSchema }, async (request, reply) => {
    const labOid = await resolveLabOrFail(request.params.labId, reply);
    if (!labOid) return;

    const staffOid = toId(request.params.id);
    if (!staffOid) return reply.code(400).send({ message: "Invalid staff ID format" });

    const member = await col().findOne({ _id: staffOid, labId: labOid, ...alive });
    if (!member) return reply.code(404).send({ message: "Staff member not found" });

    return member;
  });

  // ── POST /labs/:labId/staff/admin — create lab admin ──────────────────────
  fastify.post("/labs/:labId/staff/admin", { schema: createAdminSchema }, async (request, reply) => {
    const labOid = await resolveLabOrFail(request.params.labId, reply);
    if (!labOid) return;

    const { name, phone, email, isActive = true } = request.body;

    const normalizedPhone = phone.trim();
    const normalizedEmail = email ? email.toLowerCase().trim() : null;

    if (normalizedPhone === SUPPORT_ADMIN_PHONE) {
      return reply.code(400).send({ message: `Phone "${normalizedPhone}" is reserved` });
    }
    if (await phoneExistsInLab(labOid, normalizedPhone)) {
      return reply.code(409).send({ message: `Phone "${normalizedPhone}" is already registered in this lab` });
    }
    if (normalizedEmail && (await emailExistsInLab(labOid, normalizedEmail))) {
      return reply.code(409).send({ message: `Email "${normalizedEmail}" is already registered in this lab` });
    }

    const doc = {
      labId: labOid,
      name: name.trim(),
      phone: normalizedPhone,
      role: ROLES.ADMIN,
      permissions: ALL_PERMISSIONS_ON, // admins always get full access
      isActive,
      isDeleted: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    if (normalizedEmail) doc.email = normalizedEmail;

    const result = await col().insertOne(doc);
    const created = await col().findOne({ _id: result.insertedId });
    return reply.code(201).send(created);
  });

  // ── POST /labs/:labId/staff/member — create staff member ──────────────────
  fastify.post("/labs/:labId/staff/member", { schema: createStaffSchema }, async (request, reply) => {
    const labOid = await resolveLabOrFail(request.params.labId, reply);
    if (!labOid) return;

    const { name, phone, email, permissions, isActive = true } = request.body;

    const normalizedPhone = phone.trim();
    const normalizedEmail = email ? email.toLowerCase().trim() : null;

    if (normalizedPhone === SUPPORT_ADMIN_PHONE) {
      return reply.code(400).send({ message: `Phone "${normalizedPhone}" is reserved` });
    }
    if (await phoneExistsInLab(labOid, normalizedPhone)) {
      return reply.code(409).send({ message: `Phone "${normalizedPhone}" is already registered in this lab` });
    }
    if (normalizedEmail && (await emailExistsInLab(labOid, normalizedEmail))) {
      return reply.code(409).send({ message: `Email "${normalizedEmail}" is already registered in this lab` });
    }

    const doc = {
      labId: labOid,
      name: name.trim(),
      phone: normalizedPhone,
      role: ROLES.STAFF,
      permissions: normalizePermissions(permissions), // custom per staff member
      isActive,
      isDeleted: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    if (normalizedEmail) doc.email = normalizedEmail;

    const result = await col().insertOne(doc);
    const created = await col().findOne({ _id: result.insertedId });
    return reply.code(201).send(created);
  });

  // ── POST /labs/:labId/staff/support — create support admin ────────────────
  // One per lab. Phone is fixed to SUPPORT_ADMIN_PHONE sentinel. Password only.
  fastify.post("/labs/:labId/staff/support", { schema: createSupportAdminSchema }, async (request, reply) => {
    const labOid = await resolveLabOrFail(request.params.labId, reply);
    if (!labOid) return;

    // Only one support admin allowed per lab
    const existing = await col().findOne({ labId: labOid, phone: SUPPORT_ADMIN_PHONE, ...alive });
    if (existing) return reply.code(409).send({ message: "Support admin already exists for this lab" });

    const { password } = request.body;

    const result = await col().insertOne({
      labId: labOid,
      name: "Support Admin",
      phone: SUPPORT_ADMIN_PHONE, // sentinel — never a real number
      role: ROLES.SUPPORT_ADMIN,
      permissions: ALL_PERMISSIONS_ON, // full access
      password, // hash this before storing in your auth layer
      isActive: true,
      isDeleted: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const created = await col().findOne({ _id: result.insertedId });
    return reply.code(201).send(created);
  });

  // ── PATCH /labs/:labId/staff/:id ───────────────────────────────────────────
  fastify.patch("/labs/:labId/staff/:id", { schema: updateStaffSchema }, async (request, reply) => {
    const labOid = await resolveLabOrFail(request.params.labId, reply);
    if (!labOid) return;

    const staffOid = toId(request.params.id);
    if (!staffOid) return reply.code(400).send({ message: "Invalid staff ID format" });

    const existing = await col().findOne({ _id: staffOid, labId: labOid, ...alive });
    if (!existing) return reply.code(404).send({ message: "Staff member not found" });

    if (isSupportAdmin(existing)) {
      return reply.code(403).send({ message: "Support admin cannot be updated via this route" });
    }

    const { name, phone, email, permissions, isActive } = request.body;
    const updates = { updatedAt: new Date() };

    if (name) updates.name = name.trim();

    if (phone) {
      const normalized = phone.trim();
      if (normalized === SUPPORT_ADMIN_PHONE) {
        return reply.code(400).send({ message: `Phone "${normalized}" is reserved` });
      }
      if (await phoneExistsInLab(labOid, normalized, staffOid)) {
        return reply.code(409).send({ message: `Phone "${normalized}" is already registered in this lab` });
      }
      updates.phone = normalized;
    }

    if (email) {
      const normalized = email.toLowerCase().trim();
      if (await emailExistsInLab(labOid, normalized, staffOid)) {
        return reply.code(409).send({ message: `Email "${normalized}" is already registered in this lab` });
      }
      updates.email = normalized;
    }

    // Permissions update only applies to staff — admins always keep full access
    if (permissions) {
      if (existing.role === ROLES.ADMIN || existing.role === ROLES.SUPPORT_ADMIN) {
        return reply.code(400).send({ message: "Permissions cannot be changed for admins" });
      }
      updates.permissions = normalizePermissions(permissions);
    }

    if (isActive !== undefined) updates.isActive = isActive;

    if (Object.keys(updates).length === 1) {
      return reply.code(400).send({ message: "Nothing to update" });
    }

    const result = await col().findOneAndUpdate(
      { _id: staffOid, labId: labOid, ...alive },
      { $set: updates },
      { returnDocument: "after" },
    );

    if (!result) return reply.code(404).send({ message: "Staff member not found" });
    return result;
  });

  // ── PATCH /labs/:labId/staff/:id/activate ─────────────────────────────────
  fastify.patch("/labs/:labId/staff/:id/activate", { schema: activateStaffSchema }, async (request, reply) => {
    const labOid = await resolveLabOrFail(request.params.labId, reply);
    if (!labOid) return;

    const staffOid = toId(request.params.id);
    if (!staffOid) return reply.code(400).send({ message: "Invalid staff ID format" });

    const result = await col().findOneAndUpdate(
      { _id: staffOid, labId: labOid, ...alive },
      { $set: { isActive: true, updatedAt: new Date() } },
      { returnDocument: "after" },
    );

    if (!result) return reply.code(404).send({ message: "Staff member not found" });
    return result;
  });

  // ── PATCH /labs/:labId/staff/:id/deactivate ───────────────────────────────
  fastify.patch("/labs/:labId/staff/:id/deactivate", { schema: deactivateStaffSchema }, async (request, reply) => {
    const labOid = await resolveLabOrFail(request.params.labId, reply);
    if (!labOid) return;

    const staffOid = toId(request.params.id);
    if (!staffOid) return reply.code(400).send({ message: "Invalid staff ID format" });

    const result = await col().findOneAndUpdate(
      { _id: staffOid, labId: labOid, ...alive },
      { $set: { isActive: false, updatedAt: new Date() } },
      { returnDocument: "after" },
    );

    if (!result) return reply.code(404).send({ message: "Staff member not found" });
    return result;
  });

  // ── DELETE /labs/:labId/staff/:id — soft delete ───────────────────────────
  fastify.delete("/labs/:labId/staff/:id", { schema: deleteStaffSchema }, async (request, reply) => {
    const labOid = await resolveLabOrFail(request.params.labId, reply);
    if (!labOid) return;

    const staffOid = toId(request.params.id);
    if (!staffOid) return reply.code(400).send({ message: "Invalid staff ID format" });

    const existing = await col().findOne({ _id: staffOid, labId: labOid, ...alive });
    if (!existing) return reply.code(404).send({ message: "Staff member not found" });

    if (isSupportAdmin(existing)) {
      return reply.code(403).send({ message: "Support admin cannot be deleted" });
    }

    const result = await col().findOneAndUpdate(
      { _id: staffOid, labId: labOid, ...alive },
      { $set: { isDeleted: true, isActive: false, updatedAt: new Date() } },
      { returnDocument: "after" },
    );

    if (!result) return reply.code(404).send({ message: "Staff member not found" });
    return { message: "Staff member deleted successfully" };
  });
}
