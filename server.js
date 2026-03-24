import "dotenv/config";

import Fastify from "fastify";
import fastifyJwt from "@fastify/jwt";
import fastifyCookie from "@fastify/cookie";
import bcrypt from 'bcryptjs'
import cors from "@fastify/cors";
import mongoPlugin from "./plugins/mongo.js";
import categoryRoutes from "./routes/category/category.js";
import testRoutes from "./routes/test/test.js";
import labRoutes from "./routes/lab/lab.js";
import zoneRoutes from "./routes/zone/zone.js";
import staffRoutes from "./routes/staff/staff.js";
import testSchemaRoutes from "./routes/testSchema/testSchema.js";
import demoReportRoutes from "./routes/demoReport/demoReport.js";

const fastify = Fastify({
  disableRequestLogging: true,
  logger: {
    transport: {
      target: "pino-pretty",
      options: {
        ignore: "pid,hostname,level,time,reqId,req,res,responseTime",
      },
    },
  },
});



// ── CORS ──────────────────────────────────────────────────────────────────────
await fastify.register(cors, {
  origin: process.env.CORS_ORIGIN || "*",
  methods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
});

// ── Plugins ───────────────────────────────────────────────────────────────────
await fastify.register(mongoPlugin);


// JWT plugin – we'll use a different secret for refresh tokens (optional)
fastify.register(fastifyJwt, {
  secret: process.env.JWT_SECRET || "access-secret",
  sign: {
    expiresIn: "15m", // access token expires in 15 minutes
  },
});

fastify.register(fastifyCookie)

// Auth decorator (access token only)
fastify.decorate('authenticate', async function (request, reply) {
  try {
    await request.jwtVerify()
  } catch (err) {
    reply.code(401).send({ error: 'Unauthorized - invalid or expired access token' })
    throw err
  }
})

fastify.post('/register', async (request, reply) => {
  const { username, password } = request.body || {}

  if (!username || !password) {
    return reply.code(400).send({ error: 'Username and password required' })
  }

  const collection = fastify.mongo.db.collection('kingo')

  const exists = await collection.findOne({ username })
  if (exists) {
    return reply.code(409).send({ error: 'Username already taken' })
  }

  const hashedPassword = await bcrypt.hash(password, 10)

  const result = await collection.insertOne({
    username,
    password: hashedPassword
  })

  return {
    message: 'User registered successfully',
    id: result.insertedId.toString()
  }
})


// 4. LOGIN
fastify.post('/login', async (request, reply) => {
  const { username, password } = request.body || {}

  const user = await fastify.mongo.db.collection('kingo').findOne({ username })
  if (!user || !(await bcrypt.compare(password, user.password))) {
    return reply.code(401).send({ error: 'Invalid credentials' })
  }

  const payload = {
    id: user._id.toString(),
    username: user.username
  }

  const accessToken = await reply.jwtSign(payload)
  const refreshToken = await reply.jwtSign(payload, { expiresIn: '7d' })

  await fastify.mongo.db.collection('tokensOfKingo').insertOne({
    userId: payload.id,
    refreshToken,
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
  })

  reply.setCookie('refreshToken', refreshToken, {
    path: '/',
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: 7 * 24 * 60 * 60
  })

  return { accessToken }
})

// 5. REFRESH
fastify.post('/refresh', async (request, reply) => {
  try {
    await request.jwtVerify({ onlyCookie: true })

    const cookieToken = request.cookies.refreshToken
    if (!cookieToken) {
      return reply.code(401).send({ error: 'No refresh token' })
    }

    const refreshCollection = fastify.mongo.db.collection('tokensOfKingo')

    const refreshDoc = await refreshCollection.findOne({
      refreshToken: cookieToken,
      expiresAt: { $gt: new Date() }
    })

    if (!refreshDoc) {
      return reply.code(401).send({ error: 'Refresh token invalid or revoked' })
    }

    const payload = {
      id: request.user.id,
      username: request.user.username
    }

    const newAccessToken = await reply.jwtSign(payload)
    const newRefreshToken = await reply.jwtSign(payload, { expiresIn: '7d' })

    await refreshCollection.deleteOne({ refreshToken: cookieToken })
    await refreshCollection.insertOne({
      userId: payload.id,
      refreshToken: newRefreshToken,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
    })

    reply.setCookie('refreshToken', newRefreshToken, {
      path: '/',
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 7 * 24 * 60 * 60
    })

    return { accessToken: newAccessToken }
  } catch (err) {
    reply.code(401).send({ error: 'Invalid refresh token' })
    throw err
  }
})

// 6. LOGOUT
fastify.post('/logout', { onRequest: [fastify.authenticate] }, async (request, reply) => {
  const cookieToken = request.cookies.refreshToken

  if (cookieToken) {
    await fastify.mongo.db.collection('tokensOfKingo').deleteOne({ refreshToken: cookieToken })
  }

  reply.clearCookie('refreshToken', { path: '/' })

  return { message: 'Logged out successfully' }
})

// 7. PROTECTED
fastify.get('/protected', {
  onRequest: [fastify.authenticate]
}, async (request) => {
  return {
    message: 'You are authenticated!',
    user: request.user
  }
})

// ── Routes ────────────────────────────────────────────────────────────────────
fastify.register(categoryRoutes, { prefix: "/api/v1" });
fastify.register(testRoutes, { prefix: "/api/v1" });
fastify.register(labRoutes, { prefix: "/api/v1" });
fastify.register(zoneRoutes, { prefix: "/api/v1" });
fastify.register(staffRoutes, { prefix: "/api/v1" });
fastify.register(testSchemaRoutes, { prefix: "/api/v1" });
fastify.register(demoReportRoutes, { prefix: "/api/v1" });

// ── Health check ──────────────────────────────────────────────────────────────
fastify.get("/health", async () => ({ status: "ok" }));

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || "0.0.0.0";

try {
  await fastify.listen({ port: PORT, host: HOST });
} catch (err) {
  fastify.log.error(err);
  process.exit(1);
}
