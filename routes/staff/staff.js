import bcrypt from "bcryptjs";
import toObjectId from "../../utils/db.js";

const ROLES = {
  ADMIN: "admin",
  STAFF: "staff",
  SUPPORT_ADMIN: "supportAdmin",
};

const SUPPORT_ADMIN_PHONE = "SUPPORTADMIN";

const ALL_PERMISSIONS_ON = {
  createInvoice: true,
  editInvoice: true,
  deleteInvoice: true,
  cashmemo: true,
  uploadReport: true,
  downloadReport: true,
};

const OID = { type: "string", minLength: 24, maxLength: 24, pattern: "^[a-fA-F0-9]{24}$" };

const labIdParam = { type: "object", additionalProperties: false, properties: { labId: OID } };
const labStaffParam = { type: "object", additionalProperties: false, properties: { labId: OID, id: OID } };

const permissionsSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    createInvoice: { type: "boolean" },
    editInvoice: { type: "boolean" },
    deleteInvoice: { type: "boolean" },
    cashmemo: { type: "boolean" },
    uploadReport: { type: "boolean" },
    downloadReport: { type: "boolean" },
  },
};

const nameField = { type: "string", minLength: 1, maxLength: 100 };
const phoneField = { type: "string", minLength: 10, maxLength: 15 };
const emailField = { type: "string", anyOf: [{ format: "email" }, { maxLength: 0 }] };
const passField = { type: "string", minLength: 6, maxLength: 60 };

// ─── Route Schemas ────────────────────────────────────────────────────────────

const listStaffSchema = {
  schema: {
    tags: ["Staff"],
    summary: "List all staff & admins of a lab",
    params: labIdParam,
  },
};

const getStaffByIdSchema = {
  schema: {
    tags: ["Staff"],
    summary: "Get a staff member by ID",
    params: labStaffParam,
  },
};

const createAdminSchema = {
  schema: {
    tags: ["Staff"],
    summary: "Create a lab admin",
    params: labIdParam,
    body: {
      type: "object",
      required: ["name", "phone", "password"],
      additionalProperties: false,
      properties: {
        name: nameField,
        phone: phoneField,
        email: emailField,
        password: passField,
        isActive: { type: "boolean" },
      },
    },
  },
};

const createStaffMemberSchema = {
  schema: {
    tags: ["Staff"],
    summary: "Create a lab staff member",
    params: labIdParam,
    body: {
      type: "object",
      required: ["name", "phone", "password", "permissions"],
      additionalProperties: false,
      properties: {
        name: nameField,
        phone: phoneField,
        email: emailField,
        password: passField,
        permissions: permissionsSchema,
        isActive: { type: "boolean" },
      },
    },
  },
};

const createSupportAdminSchema = {
  schema: {
    tags: ["Staff"],
    summary: "Create the lab support admin",
    params: labIdParam,
    body: {
      type: "object",
      required: ["password"],
      additionalProperties: false,
      properties: { password: passField },
    },
  },
};

const updateSupportPasswordSchema = {
  schema: {
    tags: ["Staff"],
    summary: "Update support admin password",
    params: labIdParam,
    body: {
      type: "object",
      required: ["password"],
      additionalProperties: false,
      properties: { password: passField },
    },
  },
};

const deleteSupportAdminSchema = {
  schema: {
    tags: ["Staff"],
    summary: "Hard delete the lab support admin",
    params: labIdParam,
  },
};

const updateStaffSchema = {
  schema: {
    tags: ["Staff"],
    summary: "Update a staff member or admin",
    params: labStaffParam,
    body: {
      type: "object",
      minProperties: 1,
      additionalProperties: false,
      properties: {
        name: nameField,
        phone: phoneField,
        email: emailField,
        permissions: permissionsSchema,
        isActive: { type: "boolean" },
      },
    },
  },
};

const activateStaffSchema = {
  schema: {
    tags: ["Staff"],
    summary: "Activate a staff member",
    params: labStaffParam,
  },
};

const deactivateStaffSchema = {
  schema: {
    tags: ["Staff"],
    summary: "Deactivate a staff member",
    params: labStaffParam,
  },
};

const softDeleteStaffSchema = {
  schema: {
    tags: ["Staff"],
    summary: "Soft delete a staff member",
    params: labStaffParam,
  },
};

// ─── Routes ───────────────────────────────────────────────────────────────────

export default async function staffRoutes(fastify) {
  const col = () => fastify.mongo.db.collection("staffs");
  const labCol = () => fastify.mongo.db.collection("labs");

  const alive = { "deletion.status": { $ne: true } };

  const normalizePermissions = (perms = {}) => ({
    createInvoice: perms.createInvoice ?? false,
    editInvoice: perms.editInvoice ?? false,
    deleteInvoice: perms.deleteInvoice ?? false,
    cashmemo: perms.cashmemo ?? false,
    uploadReport: perms.uploadReport ?? false,
    downloadReport: perms.downloadReport ?? false,
  });

  const resolveLab = async (rawLabId, reply) => {
    const oid = toObjectId(rawLabId);
    if (!oid) {
      reply.code(400).send({ message: "Invalid lab ID format" });
      return null;
    }

    const lab = await labCol().findOne({ _id: oid }, { projection: { _id: 1, labKey: 1 } });
    if (!lab) {
      reply.code(404).send({ message: "Lab not found" });
      return null;
    }

    return { _id: oid, labKey: Number(lab.labKey) }; // ← _id stored as ObjectId, not string
  };

  const phoneExistsInLab = (labId, phone, excludeId = null) => {
    const q = { labId, phone, ...alive };
    if (excludeId) q._id = { $ne: excludeId };
    return col().findOne(q, { projection: { _id: 1 } });
  };

  const emailExistsInLab = (labId, email, excludeId = null) => {
    const q = { labId, email, ...alive };
    if (excludeId) q._id = { $ne: excludeId };
    return col().findOne(q, { projection: { _id: 1 } });
  };

  // ── GET /labs/:labId/staff ─────────────────────────────────────────────────
  fastify.get("/labs/:labId/staff", listStaffSchema, async (req, reply) => {
    const lab = await resolveLab(req.params.labId, reply);
    if (!lab) return;
    return col()
      .find({ labId: lab._id, ...alive })
      .sort({ role: 1, name: 1 })
      .toArray();
  });

  // ── GET /labs/:labId/staff/:id ─────────────────────────────────────────────
  fastify.get("/labs/:labId/staff/:id", getStaffByIdSchema, async (req, reply) => {
    const lab = await resolveLab(req.params.labId, reply);
    if (!lab) return;

    const staffId = toObjectId(req.params.id);
    if (!staffId) return reply.code(400).send({ message: "Invalid staff ID format" });

    const member = await col().findOne({ _id: staffId, labId: lab._id, ...alive });
    if (!member) return reply.code(404).send({ message: "Staff member not found" });
    return member;
  });

  // ── POST /labs/:labId/staff/admin ──────────────────────────────────────────
  fastify.post("/labs/:labId/staff/admin", createAdminSchema, async (req, reply) => {
    const lab = await resolveLab(req.params.labId, reply);
    if (!lab) return;

    const { name, phone, email, password, isActive = true } = req.body;
    const nPhone = phone.trim();
    const nEmail = email ? email.toLowerCase().trim() : null;

    if (nPhone === SUPPORT_ADMIN_PHONE) return reply.code(400).send({ message: `Phone "${nPhone}" is reserved` });
    if (await phoneExistsInLab(lab._id, nPhone))
      return reply.code(409).send({ message: `Phone "${nPhone}" is already registered in this lab` });
    if (nEmail && (await emailExistsInLab(lab._id, nEmail)))
      return reply.code(409).send({ message: `Email "${nEmail}" is already registered in this lab` });

    const doc = {
      labId: lab._id, // ← stored as ObjectId
      labKey: lab.labKey,
      name: name.trim(),
      phone: nPhone,
      password: await bcrypt.hash(password, 10),
      role: ROLES.ADMIN,
      permissions: ALL_PERMISSIONS_ON,
      isActive,
      deletion: { status: false, at: null, by: null },
      created: { at: Date.now(), by: { id: null, name: "SYSTEM ADMIN" } },
    };
    if (nEmail) doc.email = nEmail;

    const result = await col().insertOne(doc);
    return reply.code(201).send(await col().findOne({ _id: result.insertedId }));
  });

  // ── POST /labs/:labId/staff/member ─────────────────────────────────────────
  fastify.post("/labs/:labId/staff/member", createStaffMemberSchema, async (req, reply) => {
    const lab = await resolveLab(req.params.labId, reply);
    if (!lab) return;

    const { name, phone, email, password, permissions, isActive = true } = req.body;
    const nPhone = phone.trim();
    const nEmail = email ? email.toLowerCase().trim() : null;

    if (nPhone === SUPPORT_ADMIN_PHONE) return reply.code(400).send({ message: `Phone "${nPhone}" is reserved` });
    if (await phoneExistsInLab(lab._id, nPhone))
      return reply.code(409).send({ message: `Phone "${nPhone}" is already registered in this lab` });
    if (nEmail && (await emailExistsInLab(lab._id, nEmail)))
      return reply.code(409).send({ message: `Email "${nEmail}" is already registered in this lab` });

    const doc = {
      labId: lab._id, // ← stored as ObjectId
      labKey: lab.labKey,
      name: name.trim(),
      phone: nPhone,
      password: await bcrypt.hash(password, 10),
      role: ROLES.STAFF,
      permissions: normalizePermissions(permissions),
      isActive,
      deletion: { status: false, at: null, by: null },
      created: { at: Date.now(), by: { id: null, name: "SYSTEM ADMIN" } },
    };
    if (nEmail) doc.email = nEmail;

    const result = await col().insertOne(doc);
    return reply.code(201).send(await col().findOne({ _id: result.insertedId }));
  });

  // ── POST /labs/:labId/staff/support ────────────────────────────────────────
  fastify.post("/labs/:labId/staff/support", createSupportAdminSchema, async (req, reply) => {
    const lab = await resolveLab(req.params.labId, reply);
    if (!lab) return;

    if (await col().findOne({ labId: lab._id, phone: SUPPORT_ADMIN_PHONE, ...alive }))
      return reply.code(409).send({ message: "Support admin already exists for this lab" });

    const result = await col().insertOne({
      labId: lab._id, // ← stored as ObjectId
      labKey: lab.labKey,
      name: "Support Admin",
      phone: SUPPORT_ADMIN_PHONE,
      password: await bcrypt.hash(req.body.password, 10),
      role: ROLES.SUPPORT_ADMIN,
      permissions: ALL_PERMISSIONS_ON,
      isActive: true,
      deletion: { status: false, at: null, by: null },
      created: { at: Date.now(), by: { id: null, name: "SYSTEM ADMIN" } },
    });

    return reply.code(201).send(await col().findOne({ _id: result.insertedId }));
  });

  // ── PATCH /labs/:labId/staff/support ──────────────────────────────────────
  fastify.patch("/labs/:labId/staff/support", updateSupportPasswordSchema, async (req, reply) => {
    const lab = await resolveLab(req.params.labId, reply);
    if (!lab) return;

    const support = await col().findOne({ labId: lab._id, phone: SUPPORT_ADMIN_PHONE, ...alive });
    if (!support) return reply.code(404).send({ message: "Support admin not found for this lab" });

    const result = await col().findOneAndUpdate(
      { _id: support._id },
      {
        $set: {
          password: await bcrypt.hash(req.body.password, 10),
          updated: { at: Date.now(), by: { id: null, name: "SYSTEM ADMIN" } },
        },
      },
      { returnDocument: "after" },
    );

    if (!result) return reply.code(404).send({ message: "Support admin not found" });
    return { message: "Support admin password updated successfully" };
  });

  // ── DELETE /labs/:labId/staff/support ─────────────────────────────────────
  fastify.delete("/labs/:labId/staff/support", deleteSupportAdminSchema, async (req, reply) => {
    const lab = await resolveLab(req.params.labId, reply);
    if (!lab) return;

    const support = await col().findOne({ labId: lab._id, phone: SUPPORT_ADMIN_PHONE, ...alive });
    if (!support) return reply.code(404).send({ message: "Support admin not found for this lab" });

    await col().deleteOne({ _id: support._id });
    return { message: "Support admin permanently deleted" };
  });

  // ── PATCH /labs/:labId/staff/:id ───────────────────────────────────────────
  fastify.patch("/labs/:labId/staff/:id", updateStaffSchema, async (req, reply) => {
    const lab = await resolveLab(req.params.labId, reply);
    if (!lab) return;

    const staffId = toObjectId(req.params.id);
    if (!staffId) return reply.code(400).send({ message: "Invalid staff ID format" });

    const existing = await col().findOne({ _id: staffId, labId: lab._id, ...alive });
    if (!existing) return reply.code(404).send({ message: "Staff member not found" });
    if (existing.phone === SUPPORT_ADMIN_PHONE)
      return reply.code(403).send({ message: "Support admin cannot be updated via this route" });

    const { name, phone, email, permissions, isActive } = req.body;
    const updates = {};

    if (name) updates.name = name.trim();

    if (phone) {
      const n = phone.trim();
      if (n === SUPPORT_ADMIN_PHONE) return reply.code(400).send({ message: `Phone "${n}" is reserved` });
      if (await phoneExistsInLab(lab._id, n, staffId))
        return reply.code(409).send({ message: `Phone "${n}" is already registered in this lab` });
      updates.phone = n;
    }

    if (email) {
      const n = email.toLowerCase().trim();
      if (await emailExistsInLab(lab._id, n, staffId))
        return reply.code(409).send({ message: `Email "${n}" is already registered in this lab` });
      updates.email = n;
    }

    if (permissions) {
      if (existing.role === ROLES.ADMIN)
        return reply.code(400).send({ message: "Permissions cannot be changed for admins" });
      updates.permissions = normalizePermissions(permissions);
    }

    if (isActive !== undefined) updates.isActive = isActive;

    if (Object.keys(updates).length === 0) return reply.code(400).send({ message: "Nothing to update" });

    const result = await col().findOneAndUpdate(
      { _id: staffId, labId: lab._id, ...alive },
      { $set: { ...updates, updated: { at: Date.now(), by: { id: null, name: "SYSTEM ADMIN" } } } },
      { returnDocument: "after" },
    );

    if (!result) return reply.code(404).send({ message: "Staff member not found" });
    return result;
  });

  // ── PATCH /labs/:labId/staff/:id/activate ─────────────────────────────────
  fastify.patch("/labs/:labId/staff/:id/activate", activateStaffSchema, async (req, reply) => {
    const lab = await resolveLab(req.params.labId, reply);
    if (!lab) return;

    const staffId = toObjectId(req.params.id);
    if (!staffId) return reply.code(400).send({ message: "Invalid staff ID format" });

    const result = await col().findOneAndUpdate(
      { _id: staffId, labId: lab._id, ...alive },
      { $set: { isActive: true, updated: { at: Date.now(), by: { id: null, name: "SYSTEM ADMIN" } } } },
      { returnDocument: "after" },
    );

    if (!result) return reply.code(404).send({ message: "Staff member not found" });
    return result;
  });

  // ── PATCH /labs/:labId/staff/:id/deactivate ───────────────────────────────
  fastify.patch("/labs/:labId/staff/:id/deactivate", deactivateStaffSchema, async (req, reply) => {
    const lab = await resolveLab(req.params.labId, reply);
    if (!lab) return;

    const staffId = toObjectId(req.params.id);
    if (!staffId) return reply.code(400).send({ message: "Invalid staff ID format" });

    const result = await col().findOneAndUpdate(
      { _id: staffId, labId: lab._id, ...alive },
      { $set: { isActive: false, updated: { at: Date.now(), by: { id: null, name: "SYSTEM ADMIN" } } } },
      { returnDocument: "after" },
    );

    if (!result) return reply.code(404).send({ message: "Staff member not found" });
    return result;
  });

  // ── DELETE /labs/:labId/staff/:id ─────────────────────────────────────────
  fastify.delete("/labs/:labId/staff/:id", softDeleteStaffSchema, async (req, reply) => {
    const lab = await resolveLab(req.params.labId, reply);
    if (!lab) return;

    const staffId = toObjectId(req.params.id);
    if (!staffId) return reply.code(400).send({ message: "Invalid staff ID format" });

    const existing = await col().findOne({ _id: staffId, labId: lab._id, ...alive });
    if (!existing) return reply.code(404).send({ message: "Staff member not found" });
    if (existing.phone === SUPPORT_ADMIN_PHONE)
      return reply.code(403).send({ message: "Support admin cannot be deleted via this route" });

    const result = await col().findOneAndUpdate(
      { _id: staffId, labId: lab._id, ...alive },
      {
        $set: {
          deletion: { status: true, at: Date.now(), by: { id: null, name: "SYSTEM ADMIN" } },
          updated: { at: Date.now(), by: { id: null, name: "SYSTEM ADMIN" } },
        },
      },
      { returnDocument: "after" },
    );

    if (!result) return reply.code(404).send({ message: "Staff member not found" });
    return { message: "Staff member deleted successfully" };
  });
}
