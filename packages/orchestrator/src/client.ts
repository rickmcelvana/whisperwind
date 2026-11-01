/**
 * Client for a running world server.
 *
 * The orchestrator drives agents through the same HTTP surface an external agent would
 * use. That is deliberate: a runner holding a private island would drift from the one
 * the server is simulating, and the board it showed agents would be a fiction. Observed
 * once — the live runner passed a fabricated board listing "posts" that did not exist.
 */

import type { Action, ActionResult, Observation } from "@whisperwind/core";

export interface BoardPost {
  readonly n: number;
  readonly id: string;
  readonly tick: number;
  readonly agent: string;
  readonly content: string;
}

export interface ChatMessage {
  readonly n: number;
  readonly tick: number;
  readonly agent: string;
  readonly content: string;
}

export interface JoinResult {
  readonly session: string;
  readonly agentId: string;
  readonly playerName: string;
}

export class WorldClient {
  readonly baseUrl: string;
  private readonly session: string;

  constructor(baseUrl: string, session: string) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.session = session;
  }

  /** Join a world and return a client bound to that agent's session. */
  static async join(baseUrl: string, name: string): Promise<{ client: WorldClient; joined: JoinResult }> {
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/join?name=${encodeURIComponent(name)}`, {
      method: "POST",
    });
    const body = (await res.json()) as unknown;
    if (!res.ok) throw new Error(`join failed (${res.status}): ${JSON.stringify(body)}`);
    const joined = body as JoinResult;
    if (typeof joined.session !== "string") {
      throw new Error(`join returned no session: ${JSON.stringify(body)}`);
    }
    return { client: new WorldClient(baseUrl, joined.session), joined };
  }

  private headers(): Record<string, string> {
    return { "content-type": "application/json", "x-session": this.session };
  }

  private async request(path: string, init?: RequestInit): Promise<unknown> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: { ...this.headers(), ...(init?.headers ?? {}) },
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${path} failed (${res.status}): ${text.slice(0, 300)}`);
    return text.length > 0 ? (JSON.parse(text) as unknown) : null;
  }

  async observe(): Promise<Observation> {
    const body = await this.request("/observe");
    return body as Observation;
  }

  /** Send one action. Returns the world's verdict and the resulting observation. */
  async input(action: Action): Promise<{ result: ActionResult; observation: Observation }> {
    const body = await this.request("/input", {
      method: "POST",
      body: JSON.stringify({ type: action.type, data: action }),
    });
    const rec = body as { result: ActionResult; observation: Observation };
    return { result: rec.result, observation: rec.observation };
  }

  async post(content: string): Promise<BoardPost> {
    const body = await this.request("/board", { method: "POST", body: JSON.stringify({ content }) });
    return body as BoardPost;
  }

  async board(limit = 20): Promise<readonly BoardPost[]> {
    const body = (await this.request(`/board/recent?limit=${limit}`)) as { posts: BoardPost[] };
    return body.posts;
  }

  async chat(content: string): Promise<ChatMessage> {
    const body = await this.request("/chat", { method: "POST", body: JSON.stringify({ content }) });
    return body as ChatMessage;
  }

  async messages(after = 0, limit = 20): Promise<readonly ChatMessage[]> {
    const body = (await this.request(`/chat/messages?after=${after}&limit=${limit}`)) as {
      messages: ChatMessage[];
    };
    return body.messages;
  }

  async snapshot(): Promise<{
    format: string;
    tick: number;
    day: number;
    round: number;
    chain: string;
    state: string;
    data: string;
  }> {
    const body = await this.request("/snapshot");
    return body as { format: string; tick: number; day: number; round: number; chain: string; state: string; data: string };
  }
}
