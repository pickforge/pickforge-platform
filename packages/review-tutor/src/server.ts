import { randomBytes, timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { loadInput, type ExecFile } from "./inputs.ts";
import { initProjectPaths } from "./log.ts";
import { bootstrapHtml, pageHtml, staleSessionHtml } from "./page.ts";
import { loadTutorRubric } from "./prompt.ts";
import { validateSourceRequest, type ModelChoice } from "./protocol.ts";
import { resolveStatePaths } from "./paths.ts";
import { TutorRunner } from "./runner.ts";
import { ReviewTutorSession, type RunnerLike, type SessionReply } from "./server-session.ts";
import { SseHub } from "./sse.ts";

export interface ServerOptions {
  cwd: string;
  canonicalRepo: string;
  models: ModelChoice[];
  execFile: ExecFile;
  skillPath: string;
  runner?: RunnerLike;
  home?: string;
  initialSource?: unknown;
  startupSignal?: AbortSignal;
}

export interface ReviewTutorServer {
  url: string;
  token: string;
  close(): Promise<void>;
  port: number;
}

const responseHeaders = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

function equalToken(candidate: string | undefined, expected: string): boolean {
  if (!candidate) return false;
  const left = Buffer.from(candidate);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { ...responseHeaders, "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(value));
}

function send(response: ServerResponse, reply: SessionReply): void {
  json(response, reply.status, reply.value);
}

function rejectRequest(request: IncomingMessage, response: ServerResponse, expectedHost: string): boolean {
  const host = request.headers.host;
  if (host !== expectedHost) {
    json(response, 403, { error: `request host failed: expected ${expectedHost}, received ${host ?? "none"}; use the local Review Tutor URL` });
    return true;
  }
  const expectedOrigin = `http://${expectedHost}`;
  const origin = request.headers.origin;
  if (origin && origin !== expectedOrigin) {
    json(response, 403, { error: `request origin failed: expected ${expectedOrigin}, received ${origin}; use the local page` });
    return true;
  }
  if (request.method === "OPTIONS") {
    json(response, 405, { error: "request method failed: OPTIONS is not allowed; use the documented same-origin route" });
    return true;
  }
  return false;
}

function html(response: ServerResponse, status: number, body: string, connect = false): void {
  response.writeHead(status, {
    ...responseHeaders,
    "Content-Type": "text/html; charset=utf-8",
    "Content-Security-Policy": `default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';${connect ? " connect-src 'self';" : ""} base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
  });
  response.end(body);
}

function authorizePage(request: IncomingMessage, response: ServerResponse, url: URL, token: string): boolean {
  if (request.method !== "GET" || url.pathname !== "/") return false;
  if (!url.searchParams.has("session")) {
    html(response, 200, bootstrapHtml);
    return true;
  }
  if (!equalToken(url.searchParams.get("session") ?? undefined, token)) {
    html(response, 401, staleSessionHtml);
    return true;
  }
  html(response, 200, pageHtml, true);
  return true;
}

function isAuthorized(request: IncomingMessage, url: URL, token: string): boolean {
  const bearer = request.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
  return equalToken(bearer, token)
    || (url.pathname === "/api/events" && equalToken(url.searchParams.get("session") ?? undefined, token));
}

async function route(request: IncomingMessage, response: ServerResponse, url: URL, session: ReviewTutorSession): Promise<void> {
  const handled = await primaryRoute(request, response, url, session);
  if (handled) return;
  await secondaryRoute(request, response, url, session);
}

async function primaryRoute(request: IncomingMessage, response: ServerResponse, url: URL, session: ReviewTutorSession): Promise<boolean> {
  const method = request.method;
  const path = url.pathname;
  if (method === "GET" && path === "/api/state") send(response, session.state());
  else if (method === "POST" && path === "/api/source") send(response, await session.source(request));
  else if (method === "POST" && path === "/api/ask") send(response, await session.ask(request));
  else if (method === "GET" && path === "/api/events") session.events(request, response, url, responseHeaders);
  else {
    const cancel = path.match(/^\/api\/questions\/([^/]+)\/cancel$/);
    if (method !== "POST" || !cancel) return false;
    send(response, await session.cancel(request, cancel[1]!));
  }
  return true;
}

async function secondaryRoute(request: IncomingMessage, response: ServerResponse, url: URL, session: ReviewTutorSession): Promise<void> {
  const method = request.method;
  const path = url.pathname;
  if (method === "GET" && path === "/api/log") return send(response, await session.log(url));
  const log = path.match(/^\/api\/log\/([^/]+)$/);
  if (method === "PATCH" && log) return send(response, await session.patchLog(request, log[1]!));
  if (method === "GET" && path === "/api/export") return sendExport(response, await session.export());
  if (method === "POST" && path === "/api/heartbeat") return send(response, await session.heartbeat(request));
  json(response, 404, { error: "route failed: expected a documented Review Tutor route; refresh the page and retry" });
}

function sendExport(response: ServerResponse, html: string): void {
  response.writeHead(200, { ...responseHeaders, "Content-Type": "text/html; charset=utf-8",
    "Content-Disposition": "attachment; filename=review-tutor.html" });
  response.end(html);
}

function handleError(response: ServerResponse, error: unknown): void {
  if (response.headersSent) {
    if (!response.destroyed) response.destroy();
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  try { json(response, /at most|unknown field|expected/.test(message) ? 400 : 500, { error: message }); } catch {
    if (!response.destroyed) response.destroy();
  }
}

export async function startReviewTutorServer(options: ServerOptions): Promise<ReviewTutorServer> {
  const token = randomBytes(32).toString("base64url");
  const paths = resolveStatePaths(options.canonicalRepo, options.home);
  await initProjectPaths(paths, options.canonicalRepo);
  const session = new ReviewTutorSession(
    options, paths, await loadTutorRubric(options.skillPath), options.runner ?? new TutorRunner(), new SseHub(),
  );
  let closing: Promise<void> | undefined;
  const server = createServer(async (request, response) => {
    try {
      const address = server.address() as AddressInfo | null;
      const expectedHost = address ? `127.0.0.1:${address.port}` : "";
      if (rejectRequest(request, response, expectedHost)) return;
      const url = new URL(request.url ?? "/", `http://${expectedHost}`);
      if (authorizePage(request, response, url, token)) return;
      if (!isAuthorized(request, url, token)) return json(response, 401, {
        error: "authorization failed: expected the current bearer token; reopen /review-tutor and retry",
      });
      await route(request, response, url, session);
    } catch (error) { handleError(response, error); }
  });
  const close = (): Promise<void> => {
    if (closing) return closing;
    closing = closeRuntime(server, session);
    return closing;
  };
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    await loadInitialSource(options, session);
  } catch (error) {
    await close();
    throw error;
  }
  const port = (server.address() as AddressInfo).port;
  return { token, port, url: `http://127.0.0.1:${port}/?session=${encodeURIComponent(token)}`, close };
}

async function loadInitialSource(options: ServerOptions, session: ReviewTutorSession): Promise<void> {
  if (!options.initialSource) return;
  const loaded = await loadInput(
    validateSourceRequest(options.initialSource),
    options.cwd, options.execFile, options.startupSignal,
  );
  await session.acceptSource(loaded, false);
}

async function closeRuntime(server: ReturnType<typeof createServer>, session: ReviewTutorSession): Promise<void> {
  const listenerClosed = server.listening
    ? new Promise<void>((resolve) => server.close(() => resolve()))
    : Promise.resolve();
  await Promise.all([listenerClosed, session.close().catch(() => {})]);
}
