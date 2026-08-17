import { DurableObject } from "cloudflare:workers";
import type { CFShareManifest, PayloadDescriptor } from "../../src/types";
import { json, publicHeaders } from "./http";

const STORAGE_CHUNK_BYTES = 1_900_000;
const STORAGE_WRITE_BATCH = 8;

class PayloadError extends Error {}

interface InitRequest {
  manifest: CFShareManifest;
  expiresAt: number;
}

interface BaseShareState {
  manifest: CFShareManifest;
  expiresAt: number;
  storedChunks: number;
}

interface UploadingShareState extends BaseShareState {
  phase: "uploading";
  uploadSegments: PayloadDescriptor[];
  nextSegment: number;
}

interface ReadyShareState extends BaseShareState {
  phase: "ready";
}

type ShareState = UploadingShareState | ReadyShareState;

async function storeStream(
  storage: DurableObjectStorage,
  body: ReadableStream<Uint8Array> | null,
  expectedSize: number,
  firstChunkIndex: number,
): Promise<number> {
  if (!body) {
    if (expectedSize === 0) {
      return 0;
    }

    throw new PayloadError("Missing payload body");
  }

  const reader = body.getReader();
  const writes: Promise<void>[] = [];
  let current = new Uint8Array(STORAGE_CHUNK_BYTES);
  let currentSize = 0;
  let total = 0;
  let chunkIndex = firstChunkIndex;

  const flushWrites = async (): Promise<void> => {
    if (writes.length) {
      await Promise.all(writes.splice(0));
    }
  };

  const persist = async (data: Uint8Array): Promise<void> => {
    const key = `part:${String(chunkIndex).padStart(4, "0")}`;

    chunkIndex += 1;
    writes.push(storage.put(key, data.buffer, { noCache: true }));

    if (writes.length >= STORAGE_WRITE_BATCH) {
      await flushWrites();
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      if (total + value.byteLength > expectedSize) {
        throw new PayloadError("Payload segment exceeds its declared size");
      }

      total += value.byteLength;

      let offset = 0;

      while (offset < value.byteLength) {
        const length = Math.min(STORAGE_CHUNK_BYTES - currentSize, value.byteLength - offset);

        current.set(value.subarray(offset, offset + length), currentSize);
        currentSize += length;
        offset += length;

        if (currentSize === STORAGE_CHUNK_BYTES) {
          await persist(current);

          current = new Uint8Array(STORAGE_CHUNK_BYTES);
          currentSize = 0;
        }
      }
    }

    if (total !== expectedSize) {
      throw new PayloadError(`Payload segment ended at ${total} bytes; expected ${expectedSize}`);
    }

    if (currentSize) {
      await persist(current.slice(0, currentSize));
    }

    await flushWrites();

    return chunkIndex - firstChunkIndex;
  } catch (error) {
    await reader.cancel(error).catch(() => {});
    await Promise.allSettled(writes);

    throw error;
  }
}

function createPayloadStream(
  storage: DurableObjectStorage,
  chunkCount: number,
): ReadableStream<Uint8Array> {
  let index = 0;
  let cancelled = false;

  return new ReadableStream({
    async pull(controller) {
      if (cancelled) {
        return;
      }

      if (index >= chunkCount) {
        controller.close();
        return;
      }

      const key = `part:${String(index).padStart(4, "0")}`;
      const data = await storage.get<ArrayBuffer>(key, { noCache: true });

      if (cancelled) {
        return;
      }

      if (!data) {
        controller.error(new Error(`Stored payload chunk ${index} is missing`));
        return;
      }

      index += 1;
      controller.enqueue(new Uint8Array(data));

      if (index >= chunkCount) {
        controller.close();
      }
    },
    cancel() {
      cancelled = true;
    },
  });
}

export class ShareObject extends DurableObject<Env> {
  async removePayload(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }

  async readyState(): Promise<ReadyShareState | Response> {
    const state = await this.ctx.storage.get<ShareState>("state");

    if (!state || state.phase !== "ready") {
      return json({ error: "Share not found" }, 404);
    }

    if (Date.now() >= state.expiresAt) {
      await this.removePayload();

      return json({ error: "Share expired" }, 410);
    }

    return state;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/init") {
      const body = await request.json<InitRequest>();
      const state: UploadingShareState = {
        manifest: {
          ...body.manifest,
          payloads: [{ path: "payload.bin", size: body.manifest.storedSize }],
        },
        uploadSegments: body.manifest.payloads,
        expiresAt: body.expiresAt,
        phase: "uploading",
        nextSegment: 0,
        storedChunks: 0,
      };

      await Promise.all([
        this.ctx.storage.put("state", state),
        this.ctx.storage.setAlarm(body.expiresAt),
      ]);

      return json({ ok: true }, 201);
    }

    if (request.method === "PUT" && url.pathname.startsWith("/segment/")) {
      const state = await this.ctx.storage.get<ShareState>("state");

      if (!state || Date.now() >= state.expiresAt) {
        if (state) {
          await this.removePayload();
        }

        return json({ error: "Share expired" }, 410);
      }

      if (state.phase !== "uploading") {
        return json({ error: "Share upload is already complete" }, 409);
      }

      const segmentMatch = url.pathname.match(/^\/segment\/(0|[1-9]\d*)$/);
      const index = segmentMatch ? Number(segmentMatch[1]) : Number.NaN;

      if (!Number.isSafeInteger(index) || index >= state.uploadSegments.length) {
        return json({ error: "Invalid payload segment" }, 400);
      }

      if (index < state.nextSegment) {
        return json({ ok: true, alreadyStored: true });
      }

      if (index > state.nextSegment) {
        return json({ error: "Payload segments must be uploaded in order" }, 409);
      }

      let stored;

      try {
        stored = await storeStream(
          this.ctx.storage,
          request.body,
          state.uploadSegments[index].size,
          state.storedChunks,
        );
      } catch (error) {
        return json(
          {
            error:
              error instanceof PayloadError ? error.message : "Durable Object storage write failed",
          },
          error instanceof PayloadError ? 400 : 500,
        );
      }

      const current = await this.ctx.storage.get<ShareState>("state");

      if (!current || Date.now() >= current.expiresAt) {
        await this.removePayload();

        return json({ error: "Share expired" }, 410);
      }

      if (current.phase !== "uploading") {
        return json({ error: "Share upload is already complete" }, 409);
      }

      if (current.nextSegment !== index) {
        return json({ ok: true, alreadyStored: true });
      }

      current.nextSegment += 1;
      current.storedChunks += stored;

      await this.ctx.storage.put("state", current);

      return json({ ok: true, storedChunks: stored });
    }

    if (request.method === "POST" && url.pathname === "/complete") {
      const state = await this.ctx.storage.get<ShareState>("state");

      if (!state || Date.now() >= state.expiresAt) {
        return json({ error: "Share expired" }, 410);
      }

      if (state.phase === "ready") {
        return json({ ok: true, expiresAt: new Date(state.expiresAt).toISOString() });
      }

      if (state.nextSegment !== state.uploadSegments.length) {
        return json({ error: "Not all payload data was uploaded" }, 409);
      }

      const readyState: ReadyShareState = {
        manifest: state.manifest,
        expiresAt: state.expiresAt,
        phase: "ready",
        storedChunks: state.storedChunks,
      };

      await this.ctx.storage.put("state", readyState);

      return json({ ok: true, expiresAt: new Date(state.expiresAt).toISOString() });
    }

    if (request.method === "GET" && url.pathname === "/manifest") {
      const state = await this.readyState();

      return state instanceof Response ? state : json({ ...state.manifest });
    }

    if (request.method === "GET" && url.pathname === "/payload") {
      const state = await this.readyState();

      if (state instanceof Response) {
        return state;
      }

      return new Response(createPayloadStream(this.ctx.storage, state.storedChunks), {
        headers: {
          ...publicHeaders("application/octet-stream"),
          "Content-Length": String(state.manifest.storedSize),
        },
      });
    }

    if (request.method === "DELETE" && url.pathname === "/") {
      await this.removePayload();

      return json({ ok: true });
    }

    return json({ error: "Not found" }, 404);
  }

  async alarm(): Promise<void> {
    await this.removePayload();
  }
}
