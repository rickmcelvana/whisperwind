/**
 * In-memory stores for chat messages and board posts, shared across all sessions.
 * IDs are monotonically increasing integers starting at 1.
 */

interface ChatMessage {
  readonly id: number;
  readonly tick: number;
  readonly agent: string;
  readonly content: string;
}

interface BoardPost {
  readonly id: number;
  readonly tick: number;
  readonly agent: string;
  readonly content: string;
}

export interface ChatMessageView extends Omit<ChatMessage, "id"> {
  readonly n: number;
}

export interface BoardPostView extends Omit<BoardPost, "id"> {
  readonly n: number;
}

export class Store {
  private _chatNext = 1;
  private _boardNext = 1;
  private _chat: ChatMessage[] = [];
  private _board: BoardPost[] = [];

  /** Post a chat message from an agent. */
  postChat(tick: number, agent: string, content: string): ChatMessage {
    const msg: ChatMessage = { id: this._chatNext++, tick, agent, content };
    this._chat.push(msg);
    return msg;
  }

  /** Post a board post from an agent. */
  postBoard(tick: number, agent: string, content: string): BoardPost {
    const post: BoardPost = { id: this._boardNext++, tick, agent, content };
    this._board.push(post);
    return post;
  }

  /**
   * Chat messages after sequence number `after`, oldest first.
   * `n` is the entry's own id: deriving it from the filtered index would renumber
   * entries whenever `after` skips some, and a reader resuming from a stale cursor
   * would silently lose messages.
   */
  getChat(after?: number, limit = 20): ChatMessageView[] {
    const start = after ?? 0;
    return this._chat
      .filter((m) => m.id > start)
      .slice(0, limit)
      .map((m) => ({ n: m.id, tick: m.tick, agent: m.agent, content: m.content }));
  }

  /**
   * Messages not authored by `agent`. The server has no read cursor per agent, so
   * this is "from others since the start of the run" — the observation reports a
   * count, and the agent fetches what it wants explicitly.
   */
  unreadCount(agent: string): number {
    return this._chat.filter((m) => m.agent !== agent).length;
  }

  /** Board posts after sequence number `after`, `n` being the post's own id. */
  getBoardPosts(after?: number, limit = 100): BoardPostView[] {
    const start = after ?? 0;
    return this._board
      .filter((p) => p.id > start)
      .slice(0, limit)
      .map((p) => ({ n: p.id, tick: p.tick, agent: p.agent, content: p.content }));
  }

  /** Count of board posts and the tick of the latest one. */
  boardSummary(): { posts: number; latestTick: number | null } {
    const last = this._board.at(-1);
    return {
      posts: this._board.length,
      latestTick: last?.tick ?? null,
    };
  }
}
