import mqtt, { type MqttClient } from "mqtt";

export type TdxMqttOptions = {
  host: string;
  port: number;
  clientId: string;
  username: string;
  password: string;
};

export type TdxMqttHandle = {
  stop(): Promise<void>;
};

const CONNECT_TIMEOUT_MS = 15_000;
const RECONNECT_PERIOD_MS = 5_000;
const SUBSCRIBE_QOS = 1;

/**
 * 連上 TDX MQTT broker 並訂閱指定 topic。
 * 同一組 ClientId 只允許一條連線（第二條會踢掉第一條），呼叫端須自行持有單例。
 */
export async function startTdxMqttClient(
  options: TdxMqttOptions,
  topics: string[],
  onMessage: (topic: string, payload: Buffer) => void,
): Promise<TdxMqttHandle> {
  const { host, port, clientId, username, password } = options;
  if (!clientId || !username || !password) {
    throw new Error("TDX MQTT credentials are missing");
  }

  const client = mqtt.connect(`mqtts://${host}:${port}`, {
    clientId,
    username,
    password,
    clean: true,
    connectTimeout: CONNECT_TIMEOUT_MS,
    reconnectPeriod: RECONNECT_PERIOD_MS,
    rejectUnauthorized: true,
  });

  client.on("message", (topic: string, payload: Buffer) => {
    onMessage(topic, payload);
  });

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      void endClient(client);
      reject(error);
    };

    client.on("error", fail);
    client.on("connect", () => {
      client.subscribe(topics, { qos: SUBSCRIBE_QOS }, (error) => {
        if (error) {
          fail(error);
          return;
        }
        if (settled) return;
        settled = true;
        resolve();
      });
    });
  });

  return {
    stop: () => endClient(client),
  };
}

function endClient(client: MqttClient): Promise<void> {
  return new Promise<void>((resolve) => {
    client.end(true, {}, () => resolve());
  });
}
