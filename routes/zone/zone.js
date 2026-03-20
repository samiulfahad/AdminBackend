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

const createZoneBody = {
  type: "object",
  required: ["name"],
  properties: {
    name: { type: "string", minLength: 1 },
  },
  additionalProperties: false,
};

const updateZoneBody = {
  type: "object",
  properties: {
    name: { type: "string", minLength: 1 },
  },
  additionalProperties: false,
};

// ── Route Schemas ─────────────────────────────────────────────────────────────
const listZonesSchema = { tags: ["Zone"], summary: "List all zones" };
const getZoneSchema = { tags: ["Zone"], summary: "Get a zone by ID", params: idParam };
const createZoneSchema = { tags: ["Zone"], summary: "Create a new zone", body: createZoneBody };
const updateZoneSchema = { tags: ["Zone"], summary: "Update a zone", params: idParam, body: updateZoneBody };
const deleteZoneSchema = { tags: ["Zone"], summary: "Delete a zone", params: idParam };

// ── Routes ────────────────────────────────────────────────────────────────────
export default async function zoneRoutes(fastify) {
  function col() {
    return fastify.mongo.db.collection("zones");
  }

  function toId(id) {
    try {
      return new ObjectId(id);
    } catch {
      return null;
    }
  }

  // GET /zones/all — list all
  fastify.get("/zones/all", { schema: listZonesSchema }, async (request, reply) => {
    return col().find({}).toArray();
  });

  // GET /zones/:id — get one
  fastify.get("/zones/:id", { schema: getZoneSchema }, async (request, reply) => {
    const oid = toId(request.params.id);
    if (!oid) return reply.code(400).send({ message: "Invalid ID format" });

    const zone = await col().findOne({ _id: oid });
    if (!zone) return reply.code(404).send({ message: "Zone not found" });

    return zone;
  });

  // POST /zones — create
  fastify.post("/zones", { schema: createZoneSchema }, async (request, reply) => {
    const { name } = request.body;

    const existing = await col().findOne({ name });
    if (existing) return reply.code(409).send({ message: `Zone "${name}" already exists` });

    const result = await col().insertOne({ name });
    const created = await col().findOne({ _id: result.insertedId });

    return reply.code(201).send(created);
  });

  // PATCH /zones/:id — update
  fastify.patch("/zones/:id", { schema: updateZoneSchema }, async (request, reply) => {
    const oid = toId(request.params.id);
    if (!oid) return reply.code(400).send({ message: "Invalid ID format" });

    if (!request.body.name) return reply.code(400).send({ message: "Nothing to update" });

    const result = await col().findOneAndUpdate(
      { _id: oid },
      { $set: { name: request.body.name } },
      { returnDocument: "after" },
    );

    if (!result) return reply.code(404).send({ message: "Zone not found" });

    return result;
  });

  // DELETE /zones/:id — delete
  fastify.delete("/zones/:id", { schema: deleteZoneSchema }, async (request, reply) => {
    const oid = toId(request.params.id);
    if (!oid) return reply.code(400).send({ message: "Invalid ID format" });

    const result = await col().deleteOne({ _id: oid });
    if (result.deletedCount === 0) return reply.code(404).send({ message: "Zone not found" });

    return { message: "Zone deleted successfully" };
  });
}
