/**
 * The big-screen view (`?watch=1`, src/watch/): the phone posts what it sees and the app's state here,
 * and the watch page on the Mac (http://localhost:8791/?watch=1) follows them. In memory only: the
 * latest camera frame, the latest state snapshot and the latest copy of each large state field
 * (teardown, detail, transcript, saved). Nothing is written to disk, frames and state are never logged.
 *
 *  - POST /api/watch/frame   raw image/jpeg (at most FRAME_LIMIT): kept as the latest frame, sent to every open stream
 *  - POST /api/watch/state   JSON snapshot (at most STATE_LIMIT): kept, sent to every open event stream;
 *                            replies { watchers, full } (full: send every large field again, this server lacks one)
 *  - GET  /api/watch/stream  multipart/x-mixed-replace MJPEG of the frames as they come, for an <img>
 *  - GET  /api/watch/events  Server-Sent Events: the latest snapshot at once (with every large field and `age`,
 *                            ms since it came), then each new one; a comment every HEARTBEAT_MS
 *  - GET  /api/watch/frame   the latest frame as one JPEG (204 before the first), for `?mjpeg=0`
 * Watchers = the larger of the open stream and event connections (one watch page opens one of each).
 * Plain node:http (no Express): server/routes/watch.ts mounts these handlers, and they can be tested
 * on their own. Everything sits behind the access gate (server/lib/phoneAccess.ts) when it runs.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

export const FRAME_LIMIT = 300 * 1024;
export const STATE_LIMIT = 2 * 1024 * 1024;
export const HEARTBEAT_MS = 15_000;
export const BOUNDARY = 'blowfishframe';
/** A stream that has this much unsent (a stuck reader) skips frames until it catches up. */
const STREAM_BACKLOG = 1024 * 1024;
/** An event stream with this much unsent is closed (its page reconnects and gets the whole snapshot again). */
const EVENTS_BACKLOG = 8 * 1024 * 1024;
/** At most this many large fields are kept (the phone sends four). */
const MAX_BIG_KEYS = 16;

const NO_STORE = 'no-store, no-cache, must-revalidate, private, max-age=0';

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

type Json = Record<string, unknown>;
const isRecord = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);

interface Client {
  res: ServerResponse;
}

export class WatchHub {
  private frame: { seq: number; at: number; jpeg: Buffer } | null = null;
  private frameSeq = 0;
  private state: { at: number; snap: Json } | null = null;
  private readonly big = new Map<string, { ver: string; value: unknown }>();
  private readonly streams = new Set<Client>();
  private readonly events = new Set<Client>();
  private heartbeat: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly heartbeatMs = HEARTBEAT_MS,
    private readonly now: () => number = Date.now,
  ) {}

  /** One watch page opens one stream and one event stream: the larger of the two counts. */
  watchers(): number {
    return Math.max(this.streams.size, this.events.size);
  }

  counts(): { streams: number; events: number } {
    return { streams: this.streams.size, events: this.events.size };
  }

  latestFrame(): Buffer | null {
    return this.frame ? this.frame.jpeg : null;
  }

  /** A JPEG from the phone: kept as the latest, and written to every open stream at once. */
  putFrame(jpeg: Buffer): { seq: number; watchers: number } {
    this.frameSeq += 1;
    this.frame = { seq: this.frameSeq, at: this.now(), jpeg };
    if (this.streams.size > 0) {
      const part = framePart(jpeg, this.frameSeq);
      for (const c of this.streams) {
        if (c.res.writableLength > STREAM_BACKLOG) continue; // stuck: skip this frame, never queue
        c.res.write(part);
      }
    }
    return { seq: this.frameSeq, watchers: this.watchers() };
  }

  /**
   * A state snapshot from the phone. Its `big` fields (each with its version in `ver`) are kept apart, so a
   * watcher that comes later still gets them all; `full` asks the phone for all of them again when one this
   * snapshot names (in `ver`) is missing here (a restarted server, a dropped post).
   */
  putState(snap: Json): { watchers: number; full: boolean } {
    const ver = isRecord(snap.ver) ? snap.ver : {};
    const big = isRecord(snap.big) ? snap.big : {};
    for (const [k, value] of Object.entries(big)) {
      const v = ver[k];
      if (typeof v !== 'string') continue;
      if (!this.big.has(k) && this.big.size >= MAX_BIG_KEYS) continue;
      this.big.set(k, { ver: v, value });
    }
    const rest: Json = { ...snap };
    delete rest.big;
    delete rest.age;
    this.state = { at: this.now(), snap: rest };
    if (this.events.size > 0) {
      const live: Json = { ...rest };
      if (Object.keys(big).length > 0) live.big = big;
      const msg = sseData(live);
      for (const c of this.events) this.writeEvent(c, msg);
    }
    const full = Object.entries(ver).some(([k, v]) => this.big.get(k)?.ver !== v);
    return { watchers: this.watchers(), full };
  }

  /** The latest snapshot with every large field that matches its versions, and how old it is; null before the first. */
  fullSnapshot(): Json | null {
    if (!this.state) return null;
    const snap = this.state.snap;
    const ver = isRecord(snap.ver) ? snap.ver : {};
    const big: Json = {};
    for (const [k, v] of Object.entries(ver)) {
      const kept = this.big.get(k);
      if (kept && kept.ver === v) big[k] = kept.value;
    }
    return { ...snap, big, age: Math.max(0, this.now() - this.state.at) };
  }

  /** An MJPEG stream: the latest frame at once, then every new one. */
  openStream(req: IncomingMessage, res: ServerResponse): void {
    quiet(req, res);
    res.writeHead(200, {
      'Content-Type': `multipart/x-mixed-replace; boundary=${BOUNDARY}`,
      'Cache-Control': NO_STORE,
      Pragma: 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    // The boundary goes out ahead of each part (and right after it), so the browser shows a frame at once.
    res.write(`--${BOUNDARY}\r\n`);
    const c: Client = { res };
    this.streams.add(c);
    if (this.frame) res.write(framePart(this.frame.jpeg, this.frame.seq));
    res.on('close', () => this.streams.delete(c));
  }

  /** An event stream: the whole latest snapshot at once, then each new one, and a heartbeat comment. */
  openEvents(req: IncomingMessage, res: ServerResponse): void {
    quiet(req, res);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': NO_STORE,
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 1000\n\n');
    const c: Client = { res };
    this.events.add(c);
    const first = this.fullSnapshot();
    if (first) this.writeEvent(c, sseData(first));
    res.on('close', () => {
      this.events.delete(c);
      if (this.events.size === 0) this.stopHeartbeat();
    });
    this.startHeartbeat();
  }

  /** Close every open connection and stop the timer (tests, shutdown). */
  close(): void {
    for (const c of [...this.streams, ...this.events]) c.res.end();
    this.streams.clear();
    this.events.clear();
    this.stopHeartbeat();
  }

  private writeEvent(c: Client, msg: string): void {
    if (c.res.writableLength > EVENTS_BACKLOG) {
      this.events.delete(c);
      c.res.destroy();
      return;
    }
    c.res.write(msg);
  }

  private startHeartbeat(): void {
    if (this.heartbeat) return;
    this.heartbeat = setInterval(() => {
      for (const c of this.events) this.writeEvent(c, ': hb\n\n');
    }, this.heartbeatMs);
    this.heartbeat.unref?.();
  }

  private stopHeartbeat(): void {
    if (!this.heartbeat) return;
    clearInterval(this.heartbeat);
    this.heartbeat = null;
  }
}

/** One MJPEG part, followed at once by the next boundary line. */
export function framePart(jpeg: Buffer, seq: number): Buffer {
  const head = `Content-Type: image/jpeg\r\nContent-Length: ${jpeg.length}\r\nX-Frame-Seq: ${seq}\r\n\r\n`;
  return Buffer.concat([Buffer.from(head, 'latin1'), jpeg, Buffer.from(`\r\n--${BOUNDARY}\r\n`, 'latin1')]);
}

/** One SSE message (JSON.stringify never writes a raw newline, so one data line is enough). */
function sseData(obj: Json): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

/** Long-lived responses: no Nagle delay, no socket timeout, and a reset connection is not an error. */
function quiet(req: IncomingMessage, res: ServerResponse): void {
  req.socket.setNoDelay(true);
  req.socket.setTimeout(0);
  res.on('error', () => undefined);
}

function contentType(req: IncomingMessage): string {
  const t = req.headers['content-type'];
  return (typeof t === 'string' ? t : '').split(';')[0].trim().toLowerCase();
}

/**
 * The request body, at most `limit` bytes (else 413). Mounted before express.json, so the body is still
 * unread; a body an earlier parser already read (req._body) is used as it is.
 */
export function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const pre = req as IncomingMessage & { _body?: boolean; body?: unknown };
  if (pre._body) {
    const b = pre.body;
    const buf = Buffer.isBuffer(b) ? b : Buffer.from(JSON.stringify(b ?? null));
    return buf.length > limit ? Promise.reject(new HttpError(413, 'too large')) : Promise.resolve(buf);
  }
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > limit) {
    req.resume();
    return Promise.reject(new HttpError(413, 'too large'));
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const fail = (e: HttpError) => {
      if (done) return;
      done = true;
      reject(e);
    };
    req.on('data', (chunk: Buffer) => {
      if (done) return;
      size += chunk.length;
      if (size > limit) {
        chunks.length = 0;
        req.resume(); // read and drop the rest
        fail(new HttpError(413, 'too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      resolve(Buffer.concat(chunks, size));
    });
    req.on('error', () => fail(new HttpError(400, 'bad body')));
    req.on('aborted', () => fail(new HttpError(400, 'aborted')));
  });
}

function sendJson(res: ServerResponse, status: number, body: Json): void {
  if (res.headersSent) return;
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': NO_STORE, 'Content-Length': Buffer.byteLength(text) });
  res.end(text);
}

function sendError(res: ServerResponse, e: unknown): void {
  const status = e instanceof HttpError ? e.status : 400;
  if (status === 413) res.setHeader('Connection', 'close');
  sendJson(res, status, { error: status === 413 ? 'too_large' : status === 415 ? 'wrong_type' : 'bad_request' });
}

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

/** The five handlers, for any router that passes node's req / res (Express does). */
export function watchHandlers(hub: WatchHub): { postFrame: Handler; getFrame: Handler; postState: Handler; stream: Handler; events: Handler } {
  return {
    postFrame: (req, res) => {
      if (contentType(req) !== 'image/jpeg') {
        req.resume();
        sendError(res, new HttpError(415, 'image/jpeg only'));
        return;
      }
      readBody(req, FRAME_LIMIT).then(
        (buf) => {
          // a JPEG starts with FF D8
          if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) throw new HttpError(400, 'not a JPEG');
          sendJson(res, 200, { ok: true, ...hub.putFrame(buf) });
        },
        (e: unknown) => sendError(res, e),
      ).catch((e: unknown) => sendError(res, e));
    },
    getFrame: (_req, res) => {
      const jpeg = hub.latestFrame();
      if (!jpeg) {
        res.writeHead(204, { 'Cache-Control': NO_STORE });
        res.end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': jpeg.length, 'Cache-Control': NO_STORE });
      res.end(jpeg);
    },
    postState: (req, res) => {
      if (contentType(req) !== 'application/json') {
        req.resume();
        sendError(res, new HttpError(415, 'JSON only'));
        return;
      }
      readBody(req, STATE_LIMIT).then(
        (buf) => {
          let snap: unknown;
          try {
            snap = JSON.parse(buf.toString('utf8'));
          } catch {
            throw new HttpError(400, 'bad JSON');
          }
          if (!isRecord(snap)) throw new HttpError(400, 'not an object');
          sendJson(res, 200, hub.putState(snap));
        },
        (e: unknown) => sendError(res, e),
      ).catch((e: unknown) => sendError(res, e));
    },
    stream: (req, res) => hub.openStream(req, res),
    events: (req, res) => hub.openEvents(req, res),
  };
}
