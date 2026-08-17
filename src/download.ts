import { basename, dirname, resolve } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { decryptBuffer } from "./crypto";
import { type JsonValue } from "./json";
import { parseManifest } from "./manifest";
import { type DownloadResult } from "./types";

interface FetchShareOptions {
  passphrase?: string;
  fetchImpl?: typeof fetch;
  onProgress?: (loaded: number, total: number) => void;
}

interface SaveShareOptions extends DownloadResult {
  outputPath?: string;
  force?: boolean;
}

async function readPayload(response: Response, expectedSize: number): Promise<Buffer> {
  const contentLength = response.headers.get("Content-Length");

  if (contentLength !== null && Number(contentLength) !== expectedSize) {
    throw new Error("Payload size does not match its manifest");
  }

  if (!response.body) {
    if (expectedSize === 0) {
      return Buffer.alloc(0);
    }

    throw new Error("Payload response is missing a body");
  }

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      size += value.byteLength;
      if (size > expectedSize) {
        throw new Error("Payload exceeds its declared size");
      }

      chunks.push(Buffer.from(value));
    }
  } catch (cause) {
    await reader.cancel(cause).catch(() => {});
    throw cause;
  }

  if (size !== expectedSize) {
    throw new Error("Payload size does not match its manifest");
  }

  return Buffer.concat(chunks, size);
}

export async function fetchShare(
  url: string | URL,
  { passphrase, fetchImpl = fetch, onProgress }: FetchShareOptions = {},
): Promise<DownloadResult> {
  const pageUrl = new URL(url);
  let manifestUrl;

  if (pageUrl.pathname.endsWith("cfshare.json")) {
    manifestUrl = pageUrl;
  } else {
    const lastSegment = pageUrl.pathname.split("/").at(-1);

    manifestUrl =
      lastSegment && !lastSegment.includes(".")
        ? new URL(`${pageUrl.pathname}/cfshare.json`, pageUrl)
        : new URL("./cfshare.json", pageUrl);
  }

  const manifestResponse = await fetchImpl(manifestUrl);

  if (!manifestResponse.ok) {
    throw new Error(`Could not fetch transfer manifest (HTTP ${manifestResponse.status})`);
  }

  const manifestJson: JsonValue = await manifestResponse.json();
  const parsed = parseManifest(manifestJson);

  if (!parsed.ok) {
    throw new Error(parsed.error);
  }

  const { manifest } = parsed;

  const chunks = [];
  let loaded = 0;

  for (const payload of manifest.payloads) {
    const payloadUrl = new URL(payload.path, manifestUrl);

    if (payloadUrl.origin !== manifestUrl.origin) {
      throw new Error("Cross-origin payloads are not allowed");
    }

    const response = await fetchImpl(payloadUrl);

    if (!response.ok) {
      throw new Error(`Could not fetch ${payload.path} (HTTP ${response.status})`);
    }

    const chunk = await readPayload(response, payload.size);

    chunks.push(chunk);
    loaded += chunk.length;
    onProgress?.(loaded, manifest.storedSize);
  }

  const payload = Buffer.concat(chunks);

  if (payload.length !== manifest.storedSize) {
    throw new Error("Transfer payload size does not match its manifest");
  }

  const data = await decryptBuffer(payload, passphrase, manifest.crypto);

  if (data.length !== manifest.size) {
    throw new Error("Downloaded file size does not match its manifest");
  }

  return { manifest, data };
}

export async function saveShare({
  manifest,
  data,
  outputPath,
  force = false,
}: SaveShareOptions): Promise<string> {
  const safeName = basename(manifest.name) || "cfshare-download";
  const destination = resolve(outputPath ?? safeName);

  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, data, { flag: force ? "w" : "wx" });

  return destination;
}
