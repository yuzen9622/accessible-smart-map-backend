// Run explicitly: docker compose exec -T mongo mongosh --quiet /opt/mongo/init.js
// Credentials stay inside the container; only topology status is printed.
const admin = db.getSiblingDB("admin");
if (
  !admin.auth(
    process.env.MONGO_INITDB_ROOT_USERNAME,
    process.env.MONGO_INITDB_ROOT_PASSWORD,
  )
) {
  throw new Error("MongoDB authentication failed");
}
let initialized = false;
try {
  const config = rs.conf();
  if (
    config._id !== "rs0" ||
    config.members.length !== 1 ||
    config.members[0].host !== "mongo:27017"
  ) {
    throw new Error(
      "Unexpected replica set configuration; refusing to reconfigure",
    );
  }
  initialized = true;
} catch (error) {
  if (error.code !== 94) throw error; // NotYetInitialized only
}
if (!initialized)
  rs.initiate({ _id: "rs0", members: [{ _id: 0, host: "mongo:27017" }] });
for (let attempt = 0; attempt < 60; attempt++) {
  const hello = db.hello();
  if (hello.setName === "rs0" && hello.isWritablePrimary) {
    print("rs0 PRIMARY ready");
    quit(0);
  }
  sleep(500);
}
throw new Error("Replica set did not elect a PRIMARY within 30 seconds");
