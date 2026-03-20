// routes/kingo.js
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

const createKingoBody = {
  type: "object",
  required: ["name", "username", "email", "phone"],
  properties: {
    name: { type: "string", minLength: 1 },
    username: { type: "string", minLength: 1 },
    email: { type: "string", format: "email" },
    phone: { type: "string", minLength: 1 },
    isActive: { type: "boolean", default: true },
  },
  additionalProperties: false,
};

const updateKingoBody = {
  type: "object",
  properties: {
    name: { type: "string", minLength: 1 },
    username: { type: "string", minLength: 1 },
    email: { type: "string", format: "email" },
    phone: { type: "string", minLength: 1 },
  },
  additionalProperties: false,
};

const createSupportAdminBody = {
  type: "object",
  required: ["name", "email", "phone", "password"],
  properties: {
    name: { type: "string", minLength: 1 },
    email: { type: "string", format: "email" },
    phone: { type: "string", minLength: 1 },
    password: { type: "string", minLength: 6 },
  },
  additionalProperties: false,
};

// ── Route Schemas ─────────────────────────────────────────────────────────────
const listKingoSchema = { tags: ["Kingo"], summary: "List all kingo users" };
const getKingoSchema = { tags: ["Kingo"], summary: "Get a kingo user by ID", params: idParam };
const createKingoSchema = { tags: ["Kingo"], summary: "Create a kingo user", body: createKingoBody };
const updateKingoSchema = { tags: ["Kingo"], summary: "Update a kingo user", params: idParam, body: updateKingoBody };
const activateKingoSchema = { tags: ["Kingo"], summary: "Activate a kingo user", params: idParam };
const deactivateKingoSchema = { tags: ["Kingo"], summary: "Deactivate a kingo user", params: idParam };
const deleteKingoSchema = { tags: ["Kingo"], summary: "Delete a kingo user", params: idParam };
const createSupportAdminSchema = { tags: ["Kingo"], summary: "Create the support admin", body: createSupportAdminBody };

// ── Reserved usernames ────────────────────────────────────────────────────────
const RESERVED_USERNAMES = ["supportadmin"];

// ── Routes ────────────────────────────────────────────────────────────────────
export default async function kingoRoutes(fastify) {
  function col() {
    return fastify.mongo.db.collection("kingo");
  }

  function toId(id) {
    try {
      return new ObjectId(id);
    } catch {
      return null;
    }
  }

  const alive = { isDeleted: { $ne: true } };

  // GET /kingo/all — list all (excludes supportAdmin from general list)
  fastify.get("/kingo/all", { schema: listKingoSchema }, async (request, reply) => {
    return col()
      .find({ username: { $ne: "supportadmin" }, ...alive })
      .toArray();
  });

  // GET /kingo/:id — get one
  fastify.get("/kingo/:id", { schema: getKingoSchema }, async (request, reply) => {
    const oid = toId(request.params.id);
    if (!oid) return reply.code(400).send({ message: "Invalid ID format" });

    const user = await col().findOne({ _id: oid, ...alive });
    if (!user) return reply.code(404).send({ message: "Kingo user not found" });

    return user;
  });

  // POST /kingo — create regular admin
  fastify.post("/kingo", { schema: createKingoSchema }, async (request, reply) => {
    const { name, username, email, phone, isActive = true } = request.body;

    // block reserved usernames
    if (RESERVED_USERNAMES.includes(username.toLowerCase())) {
      return reply.code(400).send({ message: `Username "${username}" is reserved and cannot be used` });
    }

    const existingUsername = await col().findOne({ username, ...alive });
    if (existingUsername) return reply.code(409).send({ message: `Username "${username}" already exists` });

    const existingEmail = await col().findOne({ email, ...alive });
    if (existingEmail) return reply.code(409).send({ message: `Email "${email}" already exists` });

    const result = await col().insertOne({
      name,
      username,
      email,
      phone,
      isActive,
      isDeleted: false,
      role: "admin",
    });

    const created = await col().findOne({ _id: result.insertedId });
    return reply.code(201).send(created);
  });

  // POST /kingo/support — create support admin (only one allowed)
  fastify.post("/kingo/support", { schema: createSupportAdminSchema }, async (request, reply) => {
    const { name, email, phone, password } = request.body;

    const existing = await col().findOne({ username: "supportadmin", ...alive });
    if (existing) return reply.code(409).send({ message: "Support admin already exists" });

    const result = await col().insertOne({
      name,
      username: "supportadmin",
      email,
      phone,
      password,
      isActive: true,
      isDeleted: false,
      role: "supportAdmin",
    });

    const created = await col().findOne({ _id: result.insertedId });
    return reply.code(201).send(created);
  });

  // PATCH /kingo/:id — update
  fastify.patch("/kingo/:id", { schema: updateKingoSchema }, async (request, reply) => {
    const oid = toId(request.params.id);
    if (!oid) return reply.code(400).send({ message: "Invalid ID format" });

    const updates = {};
    const { name, username, email, phone } = request.body;

    if (name) updates.name = name;
    if (phone) updates.phone = phone;

    if (username) {
      // block reserved usernames on update too
      if (RESERVED_USERNAMES.includes(username.toLowerCase())) {
        return reply.code(400).send({ message: `Username "${username}" is reserved and cannot be used` });
      }

      const existing = await col().findOne({ username, _id: { $ne: oid }, ...alive });
      if (existing) return reply.code(409).send({ message: `Username "${username}" already exists` });
      updates.username = username;
    }

    if (email) {
      const existing = await col().findOne({ email, _id: { $ne: oid }, ...alive });
      if (existing) return reply.code(409).send({ message: `Email "${email}" already exists` });
      updates.email = email;
    }

    if (Object.keys(updates).length === 0) {
      return reply.code(400).send({ message: "Nothing to update" });
    }

    // prevent updating supportAdmin via this route
    const target = await col().findOne({ _id: oid, ...alive });
    if (target?.username === "supportadmin") {
      return reply.code(403).send({ message: "Support admin cannot be updated via this route" });
    }

    const result = await col().findOneAndUpdate({ _id: oid, ...alive }, { $set: updates }, { returnDocument: "after" });

    if (!result) return reply.code(404).send({ message: "Kingo user not found" });

    return result;
  });

  // PATCH /kingo/:id/activate — activate
  fastify.patch("/kingo/:id/activate", { schema: activateKingoSchema }, async (request, reply) => {
    const oid = toId(request.params.id);
    if (!oid) return reply.code(400).send({ message: "Invalid ID format" });

    const result = await col().findOneAndUpdate(
      { _id: oid, ...alive },
      { $set: { isActive: true } },
      { returnDocument: "after" },
    );

    if (!result) return reply.code(404).send({ message: "Kingo user not found" });

    return result;
  });

  // PATCH /kingo/:id/deactivate — deactivate
  fastify.patch("/kingo/:id/deactivate", { schema: deactivateKingoSchema }, async (request, reply) => {
    const oid = toId(request.params.id);
    if (!oid) return reply.code(400).send({ message: "Invalid ID format" });

    const result = await col().findOneAndUpdate(
      { _id: oid, ...alive },
      { $set: { isActive: false } },
      { returnDocument: "after" },
    );

    if (!result) return reply.code(404).send({ message: "Kingo user not found" });

    return result;
  });

  // DELETE /kingo/:id — soft delete
  fastify.delete("/kingo/:id", { schema: deleteKingoSchema }, async (request, reply) => {
    const oid = toId(request.params.id);
    if (!oid) return reply.code(400).send({ message: "Invalid ID format" });

    // prevent deleting supportAdmin
    const target = await col().findOne({ _id: oid, ...alive });
    if (target?.username === "supportadmin") {
      return reply.code(403).send({ message: "Support admin cannot be deleted" });
    }

    const result = await col().findOneAndUpdate(
      { _id: oid, ...alive },
      { $set: { isDeleted: true, isActive: false } },
      { returnDocument: "after" },
    );

    if (!result) return reply.code(404).send({ message: "Kingo user not found" });

    return { message: "Kingo user deleted successfully" };
  });
}
