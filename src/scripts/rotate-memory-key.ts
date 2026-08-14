import mongoose from "mongoose";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "crypto";
import UserMemory from "../model/user-memory.model";

const ENCRYPTED_PREFIX = "enc:v1:";
const BATCH_SIZE = 100;

/**
 * Re-encrypt AI user memories after rotating MEMORY_ENCRYPTION_KEY.
 *
 * Security incident: the previous key was committed to a public repository's
 * .env.development.example (2026-07-28) and stayed in use. Every stored memory
 * whose content carries the `enc:v1:` prefix must move from the old key to the
 * new one.
 *
 * Usage (new key must already be in .env via dotenvx):
 *   OLD_MEMORY_ENCRYPTION_KEY=<old key> npx dotenvx run -- \
 *     ts-node src/scripts/rotate-memory-key.ts
 *
 * Decryption failures are counted and left untouched, never overwritten, and
 * memory contents are never printed to the console.
 */
function deriveKey(secret: string): Buffer {
  return createHash("sha256").update(secret).digest();
}

function decryptContent(content: string, key: Buffer): string | null {
  if (!content.startsWith(ENCRYPTED_PREFIX)) return null;
  const [ivRaw, tagRaw, ciphertextRaw] = content
    .slice(ENCRYPTED_PREFIX.length)
    .split(":");
  if (!ivRaw || !tagRaw || !ciphertextRaw) return null;
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(ivRaw, "base64"),
      { authTagLength: 16 },
    );
    decipher.setAuthTag(Buffer.from(tagRaw, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertextRaw, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    return null;
  }
}

function encryptContent(content: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: 16 });
  const ciphertext = Buffer.concat([
    cipher.update(content, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return `${ENCRYPTED_PREFIX}${iv.toString("base64")}:${tag.toString(
    "base64",
  )}:${ciphertext.toString("base64")}`;
}

async function main() {
  const uri = process.env.DATABASE_URL;
  if (!uri) throw new Error("DATABASE_URL is not set");

  const oldSecret = process.env.OLD_MEMORY_ENCRYPTION_KEY;
  const newSecret = process.env.MEMORY_ENCRYPTION_KEY;
  if (!oldSecret) throw new Error("OLD_MEMORY_ENCRYPTION_KEY is not set");
  if (!newSecret) throw new Error("MEMORY_ENCRYPTION_KEY is not set");
  if (oldSecret === newSecret) {
    console.log("keys are identical, nothing to rotate");
    return;
  }

  const oldKey = deriveKey(oldSecret);
  const newKey = deriveKey(newSecret);

  await mongoose.connect(uri);
  const collection = UserMemory.collection;

  const total = await collection.countDocuments({
    content: { $regex: `^${ENCRYPTED_PREFIX}` },
  });
  console.log(`encrypted memories found: ${total}`);

  let rotated = 0;
  let failed = 0;
  const cursor = collection.find({
    content: { $regex: `^${ENCRYPTED_PREFIX}` },
  });

  while (await cursor.hasNext()) {
    const batch: {
      _id: mongoose.Types.ObjectId;
      content: string;
      reencrypted: string;
    }[] = [];
    for (let i = 0; i < BATCH_SIZE && (await cursor.hasNext()); i++) {
      const doc = await cursor.next();
      if (!doc) continue;
      const plain = decryptContent(String(doc.content), oldKey);
      if (plain === null) {
        failed++;
        continue;
      }
      batch.push({
        _id: new mongoose.Types.ObjectId(String(doc._id)),
        content: String(doc.content),
        reencrypted: encryptContent(plain, newKey),
      });
    }
    if (batch.length === 0) continue;

    const ops = batch.map((b) => ({
      updateOne: {
        filter: { _id: b._id, content: b.content },
        update: { $set: { content: b.reencrypted } },
      },
    }));
    const result = await collection.bulkWrite(ops);
    rotated += result.modifiedCount;
    console.log(`progress: ${rotated + failed}/${total}`);
  }

  console.log(`done: ${rotated} rotated, ${failed} failed (left untouched)`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error("rotation failed:", err);
  process.exit(1);
});
