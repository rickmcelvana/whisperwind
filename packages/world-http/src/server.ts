/**
 * HTTP surface for one sim instance. Agents observe and act here; nothing else.
 *
 * Node's built-in http server, no framework: the surface is eight endpoints and a
 * dependency would add a second source of truth for routing and JSON errors.
 *
 * The tick and chain are owned here and advanced only by `/input`, so an external
 * reader sees a consistent (tick, chain) pair.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";

import {
  ACTION_TYPES,
  type Action,
  type ActionResult,
  type Observation,
  type Vec3,
} from "@whisperwind/core";
import { type Island, observe, runRound, startChain, stateDigest } from "@whisperwind/sim";

import { Store, type BoardPostView, type ChatMessageView } from "./store.ts";

export interface ServerOptions {
  readonly island: Island;
  readonly port?: number;
  readonly host?: string;
  /** Agents that may join, in order. */
  readonly agentNames: readonly string[];
}

export interface RunningServer {
  readonly port: number;
  readonly close: () => Promise<void>;
}

interface Session {
  readonly token: string;
  readonly agent: string;
}

const MAX_BODY = 256 * 1024;

function isVec3(v: unknown): v is Vec3 {
  return (
    Array.isArray(v) &&
    v.length === 3 &&
    v.every((n) => typeof n === "number" && Number.isFinite(n))
  );
}

function asRecord(v: unknown): Record<string, unknown> | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  return v as Record<string, unknown>;
}

const INVALID: ActionResult = { ok: false, reason: "invalid_args", ticks: 1 };
const UNKNOWN_ACTION: ActionResult = { ok: false, reason: "unknown_action", ticks: 1 };

/**
 * Convert a wire action into the contract's Action.
 *
 * A malformed action becomes a rejected `ActionResult` rather than a 400: an agent
 * that sends a bad position should learn that the action failed, exactly as it learns
 * that Place failed with empty hands.
 */
export function wireToAction(body: unknown): { action: Action } | { rejected: ActionResult } {
  const rec = asRecord(body);
  if (!rec) return { rejected: INVALID };
  const type = rec["type"];
  if (typeof type !== "string" || !(ACTION_TYPES as readonly string[]).includes(type)) {
    return { rejected: UNKNOWN_ACTION };
  }
  const data = asRecord(rec["data"]) ?? rec;

  switch (type) {
    case "MoveTo":
    case "Pickup":
    case "Place": {
      const position = data["position"];
      if (!isVec3(position)) return { rejected: INVALID };
      if (type === "MoveTo") return { action: { type: "MoveTo", position } };
      if (type === "Pickup") return { action: { type: "Pickup", position } };
      return { action: { type: "Place", position } };
    }
    case "Throw": {
      const direction = data["direction"];
      const speed = data["speed"];
      if (!isVec3(direction) || typeof speed !== "number" || !Number.isFinite(speed)) {
        return { rejected: INVALID };
      }
      return { action: { type: "Throw", direction, speed } };
    }
    case "Jump":
      return { action: { type: "Jump" } };
    default:
      return { action: { type: "Stop" } };
  }
}

function actionMarkdown(): string {
  const rows = [
    "| Action | Data |",
    "|---|---|",
    "| MoveTo | `{position:[x,y,z]}` |",
    "| Jump | `{}` |",
    "| Stop | `{}` |",
    "| Pickup | `{position:[x,y,z]}` |",
    "| Place | `{position:[x,y,z], rotation?:{yaw,pitch,roll}}` |",
    "| Throw | `{direction:[x,y,z], speed:n}` |",
  ];
  // Generated from the contract so the document cannot advertise an action the sim lacks.
  const listed = [...ACTION_TYPES].join(", ");
  return [
    "# Island World",
    "",
    `You live in this world. Actions: ${listed}.`,
    "",
    ...rows,
    "",
    "A decision may be a sequence: a MoveTo followed by a Pickup, say.",
    "",
    "## Endpoints",
    "",
    "- `POST /join?name=<name>` -> `{session, agentId, playerName}`",
    "- `GET /observe` (header `X-Session`) -> observation",
    "- `POST /input` body `{type, data}` -> `{observation, result}`",
    "- `POST /chat` `{content}`; `GET /chat/messages?after=<n>&limit=20`",
    "- `POST /board` `{content}`; `GET /board/posts?after=<n>`",
    "- `GET /snapshot` -> `{format, tick, chain, state, data}`",
    "",
    "There is no objective, no score, and no win condition.",
    "",
  ].join("\n");
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += buf.byteLength;
    if (size > MAX_BODY) throw new Error("body too large");
    chunks.push(buf);
  }
  if (size === 0) return null;
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

function send(res: ServerResponse, status: number, body: unknown, contentType = "application/json"): void {
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, { "content-type": `${contentType}; charset=utf-8` });
  res.end(payload);
}

export async function startServer(opts: ServerOptions): Promise<RunningServer> {
  const { island } = opts;
  const store = new Store();
  const sessions = new Map<string, Session>();
  const lastResults = new Map<string, string | null>();

  let tick = 0;
  let round = 0;
  let chain = startChain();
  const day = 1;

  const agentIndex = new Map<string, number>();
  island.agents.forEach((a, i) => agentIndex.set(a.name, i));

  const boardFor = (limit = 20): readonly BoardPostView[] => {
    const all = store.getBoardPosts(0, 1000);
    return all.slice(-limit);
  };

  const observeFor = (agent: string, index: number): Observation =>
    observe(island, index, {
      tick,
      day,
      boardPosts: store.boardSummary().posts,
      boardLatestTick: store.boardSummary().latestTick,
      unreadChat: store.unreadCount(agent),
      lastResults,
    });

  const server: Server = createServer((req, res) => {
    void handle(req, res).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      if (!res.headersSent) send(res, 500, { error: message });
      else res.end();
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const path = url.pathname;
    const method = req.method ?? "GET";

    if (path === "/api.md" && method === "GET") {
      send(res, 200, actionMarkdown(), "text/markdown");
      return;
    }

    if (path === "/join" && method === "POST") {
      const name = url.searchParams.get("name");
      if (!name) {
        send(res, 400, { error: "name is required" });
        return;
      }
      const taken = new Set([...sessions.values()].map((s) => s.agent));
      const free = opts.agentNames.find((n) => !taken.has(n));
      if (!free) {
        send(res, 409, { error: "no free player slots" });
        return;
      }
      if (agentIndex.get(free) === undefined) {
        send(res, 500, { error: `agent ${free} has no body in the world` });
        return;
      }
      const token = randomUUID();
      sessions.set(token, { token, agent: free });
      lastResults.set(free, null);
      send(res, 200, { session: token, agentId: free, playerName: free });
      return;
    }

    // Everything below requires a session.
    const token = req.headers["x-session"];
    const session = typeof token === "string" ? sessions.get(token) : undefined;
    if (!session) {
      send(res, 401, { error: "invalid or missing X-Session" });
      return;
    }

    const idx = agentIndex.get(session.agent);
    if (idx === undefined) {
      send(res, 500, { error: "session has no body" });
      return;
    }

    if (path === "/observe" && method === "GET") {
      send(res, 200, observeFor(session.agent, idx));
      return;
    }

    if (path === "/input" && method === "POST") {
      let body: unknown;
      try {
        body = await readBody(req);
      } catch {
        send(res, 400, { error: "invalid JSON body" });
        return;
      }

      const converted = wireToAction(body);
      if ("rejected" in converted) {
        const reason = converted.rejected.ok === false ? converted.rejected.reason : "invalid_args";
        lastResults.set(session.agent, `rejected ${reason}`);
        // A rejected input still costs a round, so the world clock cannot be frozen by
        // an agent that only ever sends malformed actions.
        const out = runRound(island, {
          day,
          round,
          chain,
          submissions: [{ agent: session.agent, actions: [{ type: "Stop" }] }],
        });
        round++;
        chain = out.chain;
        tick += out.ticks;
        send(res, 200, { observation: observeFor(session.agent, idx), result: converted.rejected });
        return;
      }

      const out = runRound(island, {
        day,
        round,
        chain,
        submissions: [{ agent: session.agent, actions: [converted.action] }],
      });

      round++;
      chain = out.chain;
      tick += out.ticks;

      const result = out.records[0]?.result[0];
      lastResults.set(
        session.agent,
        result ? `${converted.action.type} ${result.ok ? "ok" : result.reason}` : `${converted.action.type} unknown`,
      );

      send(res, 200, {
        observation: observeFor(session.agent, idx),
        result: result ?? INVALID,
      });
      return;
    }

    if (path === "/chat" && method === "POST") {
      let body: unknown;
      try {
        body = await readBody(req);
      } catch {
        send(res, 400, { error: "invalid JSON body" });
        return;
      }
      const rec = asRecord(body);
      const content = rec ? rec["content"] : undefined;
      if (typeof content !== "string" || content.length === 0) {
        send(res, 400, { error: "content is required" });
        return;
      }
      send(res, 200, store.postChat(tick, session.agent, content));
      return;
    }

    if (path === "/chat/messages" && method === "GET") {
      const after = Number(url.searchParams.get("after") ?? 0);
      const limit = Math.min(Number(url.searchParams.get("limit") ?? 20) || 20, 100);
      const messages: readonly ChatMessageView[] = store.getChat(
        Number.isFinite(after) ? after : 0,
        limit,
      );
      send(res, 200, { messages });
      return;
    }

    if (path === "/board" && method === "POST") {
      let body: unknown;
      try {
        body = await readBody(req);
      } catch {
        send(res, 400, { error: "invalid JSON body" });
        return;
      }
      const rec = asRecord(body);
      const content = rec ? rec["content"] : undefined;
      if (typeof content !== "string" || content.length === 0) {
        send(res, 400, { error: "content is required" });
        return;
      }
      const created = store.postBoard(tick, session.agent, content);
      send(res, 200, {
        n: created.id,
        id: `post_${created.id}`,
        tick: created.tick,
        agent: created.agent,
        content: created.content,
      });
      return;
    }

    if (path === "/board/posts" && method === "GET") {
      const after = Number(url.searchParams.get("after") ?? 0);
      const posts: readonly BoardPostView[] = store.getBoardPosts(Number.isFinite(after) ? after : 0);
      send(res, 200, { posts });
      return;
    }

    if (path === "/board/recent" && method === "GET") {
      const limit = Math.min(Number(url.searchParams.get("limit") ?? 20) || 20, 200);
      send(res, 200, { posts: boardFor(limit) });
      return;
    }

    if (path === "/snapshot" && method === "GET") {
      const data = Buffer.from(island.world.takeSnapshot()).toString("base64");
      send(res, 200, {
        format: "rapier-snapshot-v1",
        tick,
        day,
        round,
        chain,
        state: stateDigest(island),
        data,
      });
      return;
    }

    send(res, 404, { error: `no route for ${method} ${path}` });
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 0, opts.host ?? "127.0.0.1", () => resolve());
  });

  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : (opts.port ?? 0);

  return {
    port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
