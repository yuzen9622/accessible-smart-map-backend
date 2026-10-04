// Benchmark-only worker: real Express handlers and real dependencies; no application jobs.
import http from "node:http";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
const root = process.argv[2];
const db = Number(process.argv[3]);
const redisHost = process.argv[4];
if (!root || ![0, 1].includes(db) || redisHost !== "metro-perf-redis")
  throw new Error("Invalid isolated benchmark configuration");
process.env.NODE_ENV = "production";
process.env.REDIS_URL = `redis://${redisHost}:6379/${db}`;
const context = new AsyncLocalStorage();
const { default: axios } =
  await import("/app/node_modules/axios/dist/node/axios.cjs");
function instrument(client) {
  client.interceptors.request.use((config) => {
    const c = context.getStore();
    if (c) {
      const url = `${config.baseURL || ""}${config.url || ""}`;
      if (url.includes("/otp/routers/default")) c.otp++;
      else c.axios++;
    }
    return config;
  });
  client.interceptors.response.use(
    (response) => response,
    (error) => {
      const c = context.getStore();
      if (c) c.upstreamErrors++;
      return Promise.reject(error);
    },
  );
  return client;
}
const createAxios = axios.create;
axios.create = function (...args) {
  return instrument(createAxios.apply(this, args));
};
instrument(axios);
const originalFetch = globalThis.fetch;
globalThis.fetch = async function (...args) {
  const c = context.getStore();
  if (c) c.fetch++;
  try {
    const response = await originalFetch.apply(this, args);
    if (c && response.status >= 400) c.upstreamErrors++;
    return response;
  } catch (error) {
    if (c) c.upstreamErrors++;
    throw error;
  }
};
let server, mongoose, redis, graph;
(async () => {
  ({ default: mongoose } = await import("/app/node_modules/mongoose/index.js"));
  mongoose.set("debug", () => {
    const c = context.getStore();
    if (c) c.mongo++;
  });
  await mongoose.connect(process.env.DATABASE_URL, {
    serverSelectionTimeoutMS: 10000,
  });
  ({ default: redis } = await import(path.join(root, "config/redis.js")));
  await redis.redisReady();
  ({ default: graph } = await import(
    path.join(
      root,
      "modules/accessible-route/planners/pedestrian-a11y/graph-runtime.js",
    )
  ));
  const runtime = await graph.getPedGraphRuntime();
  if (runtime.status !== "ready")
    throw new Error("Pedestrian graph is not ready");
  const { default: appModule } = await import(path.join(root, "app.js"));
  const app = appModule.default;
  server = http.createServer((req, res) => {
    const counters = {
      otp: 0,
      axios: 0,
      fetch: 0,
      mongo: 0,
      upstreamErrors: 0,
    };
    const writeHead = res.writeHead;
    res.writeHead = function (...args) {
      res.setHeader("X-Benchmark-Counters", JSON.stringify(counters));
      return writeHead.apply(this, args);
    };
    context.run(counters, () => app(req, res));
  });
  server.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const hashes = {};
  for (const filename of [
    "app.js",
    "modules/accessible-route/accessible-route.service.js",
    "modules/accessible-route/planners/otp-routing.js",
    "modules/accessible-route/planners/transit-preference.js",
  ]) {
    hashes[filename] = crypto
      .createHash("sha256")
      .update(fs.readFileSync(path.join(root, filename)))
      .digest("hex");
  }
  process.send({
    type: "ready",
    base: `http://127.0.0.1:${server.address().port}`,
    db,
    node: process.version,
    graph: runtime.status,
    hashes,
  });
})().catch((error) => {
  process.send?.({ type: "fatal", name: error.name });
  process.exit(1);
});
process.on("message", async (message) => {
  try {
    if (message.type === "coldRouting") {
      // Delete only this benchmark's routing-plan keys, not weather/TDX or user data.
      let cursor = "0",
        deleted = 0;
      do {
        const [next, keys] = await redis.redisClient.scan(
          cursor,
          "MATCH",
          "otp:plan:v1:*",
          "COUNT",
          500,
        );
        cursor = next;
        if (keys.length) deleted += await redis.redisClient.del(...keys);
      } while (cursor !== "0");
      process.send({ type: "control", id: message.id, deleted });
    } else if (message.type === "stop") {
      await new Promise((resolve) => server.close(resolve));
      await graph.closePedGraphRuntime();
      await mongoose.disconnect();
      redis.redisClient.disconnect();
      process.send({ type: "control", id: message.id });
      process.disconnect();
      process.exit(0);
    }
  } catch (error) {
    process.send({ type: "controlError", id: message.id, name: error.name });
  }
});
