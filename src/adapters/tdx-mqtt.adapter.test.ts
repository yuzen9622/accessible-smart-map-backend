import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("mqtt", () => ({ default: { connect: vi.fn() } }));

import mqtt from "mqtt";
import { startTdxMqttClient } from "./tdx-mqtt.adapter";

const connectMock = mqtt.connect as unknown as ReturnType<typeof vi.fn>;

type SubscribeCallback = (error: Error | null) => void;

class FakeMqttClient extends EventEmitter {
  subscribeError: Error | null = null;
  subscribe = vi.fn(
    (_topics: string[], _opts: unknown, callback: SubscribeCallback) => {
      callback(this.subscribeError);
    },
  );
  end = vi.fn((_force: boolean, _opts: unknown, callback: () => void) => {
    callback();
  });
}

const credentials = {
  host: "mqtt.transportdata.tw",
  port: 8883,
  clientId: "client-1",
  username: "user-1",
  password: "secret-1",
};

const topics = ["v2/Bus/Alert/InterCity", "v3/Rail/TRA/Alert"];

let client: FakeMqttClient;

beforeEach(() => {
  vi.clearAllMocks();
  client = new FakeMqttClient();
  connectMock.mockReturnValue(client);
});

describe("startTdxMqttClient", () => {
  it("connects with the TDX credentials over mqtts", async () => {
    const pending = startTdxMqttClient(credentials, topics, vi.fn());
    client.emit("connect");
    await pending;

    expect(connectMock).toHaveBeenCalledWith(
      "mqtts://mqtt.transportdata.tw:8883",
      expect.objectContaining({
        clientId: "client-1",
        username: "user-1",
        password: "secret-1",
        clean: true,
        rejectUnauthorized: true,
      }),
    );
  });

  it("resolves only after the subscription succeeds", async () => {
    const pending = startTdxMqttClient(credentials, topics, vi.fn());
    let settled = false;
    void pending.then(() => {
      settled = true;
    });

    expect(settled).toBe(false);
    client.emit("connect");
    await pending;

    expect(client.subscribe).toHaveBeenCalledWith(
      topics,
      { qos: 1 },
      expect.any(Function),
    );
    expect(settled).toBe(true);
  });

  it("forwards incoming messages to the handler", async () => {
    const onMessage = vi.fn();
    const pending = startTdxMqttClient(credentials, topics, onMessage);
    client.emit("connect");
    await pending;

    const payload = Buffer.from("[]");
    client.emit("message", "v3/Rail/TRA/Alert", payload);

    expect(onMessage).toHaveBeenCalledWith("v3/Rail/TRA/Alert", payload);
  });

  it("rejects and closes the client when subscribing fails", async () => {
    client.subscribeError = new Error("subscribe denied");
    const pending = startTdxMqttClient(credentials, topics, vi.fn());
    client.emit("connect");

    await expect(pending).rejects.toThrow("subscribe denied");
    expect(client.end).toHaveBeenCalled();
  });

  it("rejects on a connection error", async () => {
    const pending = startTdxMqttClient(credentials, topics, vi.fn());
    client.emit("error", new Error("bad credentials"));

    await expect(pending).rejects.toThrow("bad credentials");
  });

  it("ends the client on stop", async () => {
    const pending = startTdxMqttClient(credentials, topics, vi.fn());
    client.emit("connect");
    const handle = await pending;

    await handle.stop();

    expect(client.end).toHaveBeenCalledWith(true, {}, expect.any(Function));
  });

  it("throws when any credential is missing", async () => {
    await expect(
      startTdxMqttClient({ ...credentials, clientId: "" }, topics, vi.fn()),
    ).rejects.toThrow("TDX MQTT credentials are missing");
    await expect(
      startTdxMqttClient({ ...credentials, username: "" }, topics, vi.fn()),
    ).rejects.toThrow("TDX MQTT credentials are missing");
    await expect(
      startTdxMqttClient({ ...credentials, password: "" }, topics, vi.fn()),
    ).rejects.toThrow("TDX MQTT credentials are missing");
    expect(connectMock).not.toHaveBeenCalled();
  });
});
