import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import request from "supertest";
import sharp from "sharp";

vi.mock("../../adapters/gcs.adapter", async (importActual) => {
  const actual =
    await importActual<typeof import("../../adapters/gcs.adapter")>();
  return {
    ...actual,
    uploadAvatarObject: vi.fn(),
    readAvatarObject: vi.fn(),
    deleteAvatarObject: vi.fn(),
    deleteAvatarObjects: vi.fn(),
  };
});

vi.mock("./user.repository", async (importActual) => {
  const actual = await importActual<typeof import("./user.repository")>();
  return { ...actual, swapUserAvatar: vi.fn(), findUserAvatar: vi.fn() };
});

import {
  buildAuthorizationHeader,
  startTestServer,
  stopTestServer,
} from "../../../tests/helpers/test-helpers";
import {
  buildDbUser,
  stubAuthUserLookup,
} from "../../../tests/helpers/real-auth";
import * as gcs from "../../adapters/gcs.adapter";
import * as repository from "./user.repository";
import { ResponseCode } from "../../types/code";

const USER_ID = "65f1c0ffee0000000000abcd";
const auth = buildAuthorizationHeader({
  _id: USER_ID,
  email: "test@example.com",
});

const upload = vi.mocked(gcs.uploadAvatarObject);
const read = vi.mocked(gcs.readAvatarObject);
const purge = vi.mocked(gcs.deleteAvatarObjects);
const deleteOne = vi.mocked(gcs.deleteAvatarObject);
const swapUserAvatar = vi.mocked(repository.swapUserAvatar);
const findUserAvatar = vi.mocked(repository.findUserAvatar);

let app: Awaited<ReturnType<typeof startTestServer>>;
let landscapePng: Buffer;

beforeAll(async () => {
  app = await startTestServer();
  landscapePng = await sharp({
    create: {
      width: 1200,
      height: 600,
      channels: 3,
      background: "#3366cc",
    },
  })
    .png()
    .toBuffer();
});

afterAll(async () => {
  await stopTestServer(app);
});

beforeEach(() => {
  vi.resetAllMocks();
  stubAuthUserLookup(buildDbUser({ _id: USER_ID }));
  purge.mockResolvedValue(0);
});

describe("PATCH /api/v1/user/avatar", () => {
  it("stores a square JPEG, points the user at it, and removes old versions", async () => {
    const previousHash = "fedcba9876543210";
    swapUserAvatar.mockResolvedValue(
      `/api/v1/avatars/${USER_ID}/${previousHash}.jpg`,
    );

    const res = await request(app)
      .patch("/api/v1/user/avatar")
      .set("Authorization", auth)
      .attach("avatar", landscapePng, {
        filename: "a.png",
        contentType: "image/png",
      });

    expect(res.status).toBe(ResponseCode.OK);
    const avatarUrl: string = res.body.data.avatarUrl;
    expect(avatarUrl).toMatch(
      new RegExp(`^/api/v1/avatars/${USER_ID}/[0-9a-f]{16}\\.jpg$`),
    );

    const [stored, storagePath] = upload.mock.calls[0];
    expect(storagePath).toBe(
      `avatars/${USER_ID}/${avatarUrl.split("/").pop()}`,
    );
    const meta = await sharp(stored).metadata();
    expect(meta).toMatchObject({ format: "jpeg", width: 512, height: 512 });
    expect(meta.exif).toBeUndefined();

    expect(swapUserAvatar).toHaveBeenCalledWith(USER_ID, avatarUrl);
    // Only the replaced version is deleted, never the whole prefix: a
    // concurrent upload's object may be the one that ends up current.
    expect(deleteOne).toHaveBeenCalledExactlyOnceWith(
      `avatars/${USER_ID}/${previousHash}.jpg`,
    );
    expect(purge).not.toHaveBeenCalled();
  });

  it("leaves a provider avatar URL alone when replacing it", async () => {
    swapUserAvatar.mockResolvedValue("https://lh3.googleusercontent.com/a/x");

    const res = await request(app)
      .patch("/api/v1/user/avatar")
      .set("Authorization", auth)
      .attach("avatar", landscapePng, "a.png");

    expect(res.status).toBe(ResponseCode.OK);
    expect(deleteOne).not.toHaveBeenCalled();
  });

  it("rejects a request without a file", async () => {
    const res = await request(app)
      .patch("/api/v1/user/avatar")
      .set("Authorization", auth);

    expect(res.status).toBe(ResponseCode.INVALID_INPUT);
    expect(res.body.data.reason).toBe("AVATAR_MISSING");
    expect(upload).not.toHaveBeenCalled();
  });

  it("rejects bytes that are not a supported image, whatever the MIME says", async () => {
    const res = await request(app)
      .patch("/api/v1/user/avatar")
      .set("Authorization", auth)
      .attach("avatar", Buffer.from("<svg onload=alert(1)>"), {
        filename: "a.jpg",
        contentType: "image/jpeg",
      });

    expect(res.status).toBe(ResponseCode.INVALID_INPUT);
    expect(res.body.data.reason).toBe("AVATAR_UNSUPPORTED");
    expect(upload).not.toHaveBeenCalled();
  });

  it("requires authentication", async () => {
    const res = await request(app)
      .patch("/api/v1/user/avatar")
      .attach("avatar", landscapePng, "a.png");

    expect(res.status).toBe(ResponseCode.FORBIDDEN);
    expect(upload).not.toHaveBeenCalled();
  });

  it("removes the upload when the account disappeared meanwhile", async () => {
    swapUserAvatar.mockResolvedValue(undefined);

    const res = await request(app)
      .patch("/api/v1/user/avatar")
      .set("Authorization", auth)
      .attach("avatar", landscapePng, "a.png");

    expect(res.status).toBe(ResponseCode.NOT_FOUND);
    expect(purge).toHaveBeenCalledWith(USER_ID);
  });

  it("answers 503 when storage fails, leaving the user unchanged", async () => {
    upload.mockRejectedValue(new gcs.HazardPhotoStorageError("GCS_TIMEOUT"));

    const res = await request(app)
      .patch("/api/v1/user/avatar")
      .set("Authorization", auth)
      .attach("avatar", landscapePng, "a.png");

    expect(res.status).toBe(ResponseCode.SERVICE_UNAVAILABLE);
    expect(res.body.data.reason).toBe("AVATAR_UNAVAILABLE");
    expect(swapUserAvatar).not.toHaveBeenCalled();
  });
});

describe("GET /api/v1/avatars/:userId/:file", () => {
  const hash = "0123456789abcdef";
  const path = `/api/v1/avatars/${USER_ID}/${hash}.jpg`;

  it("serves the current avatar publicly with cache headers", async () => {
    findUserAvatar.mockResolvedValue(path);
    read.mockResolvedValue(Buffer.from([0xff, 0xd8, 0xff, 0xd9]));

    const res = await request(app).get(path);

    expect(res.status).toBe(ResponseCode.OK);
    expect(res.headers["content-type"]).toBe("image/jpeg");
    expect(res.headers["cache-control"]).toBe("public, max-age=3600");
    expect(res.headers["cross-origin-resource-policy"]).toBe("cross-origin");
    expect(read).toHaveBeenCalledWith(`avatars/${USER_ID}/${hash}.jpg`);
  });

  it("404s a replaced avatar without touching storage", async () => {
    findUserAvatar.mockResolvedValue(
      `/api/v1/avatars/${USER_ID}/fedcba9876543210.jpg`,
    );

    const res = await request(app).get(path);

    expect(res.status).toBe(ResponseCode.NOT_FOUND);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(read).not.toHaveBeenCalled();
  });

  it("never marks a storage failure as cacheable", async () => {
    findUserAvatar.mockResolvedValue(path);
    read.mockRejectedValue(new gcs.HazardPhotoStorageError("GCS_TIMEOUT"));

    const res = await request(app).get(path);

    expect(res.status).toBe(ResponseCode.SERVICE_UNAVAILABLE);
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("rejects malformed paths without a cacheable answer", async () => {
    const res = await request(app).get(
      `/api/v1/avatars/${USER_ID}/..%2F..%2Freports%2Fx.jpg`,
    );

    expect(res.status).toBe(ResponseCode.INVALID_INPUT);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(findUserAvatar).not.toHaveBeenCalled();
  });
});
