import type http from "http";
import type { WebSocketServer } from "ws";

export type WsUpgradeRoute = {
  path: string;
  wss: WebSocketServer;
};

/**
 * Per-server registry of WS upgrade routes. Every WS gateway registers its
 * { path, wss } here instead of attaching its own `server.on("upgrade", …)`,
 * so multiple gateways (voice, transit alerts, …) share ONE upgrade listener.
 * A single listener is required: Node fires *all* upgrade listeners, so two
 * listeners each writing their own 404 fallback would destroy each other's
 * sockets.
 */
const routesByServer = new WeakMap<http.Server, WsUpgradeRoute[]>();

export function registerWsRoute(
  server: http.Server,
  route: WsUpgradeRoute,
): void {
  const existing = routesByServer.get(server);
  if (existing) {
    existing.push(route);
    return;
  }

  // `routes` is a const here, so the closure keeps a stable, non-undefined
  // reference that TypeScript can narrow.
  const routes: WsUpgradeRoute[] = [route];
  routesByServer.set(server, routes);

  server.on("upgrade", (request, socket, head) => {
    const pathname = new URL(request.url ?? "", "http://localhost").pathname;
    const matched = routes.find((candidate) => candidate.path === pathname);
    if (!matched) {
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    matched.wss.handleUpgrade(request, socket, head, (ws) => {
      matched.wss.emit("connection", ws, request);
    });
  });
}
