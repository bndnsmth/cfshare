import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, sep } from "node:path";
import { deployTemporarySite } from "./cloudflare";
import { normalizeServerUrl } from "./config";
import { fetchShare, saveShare } from "./download";
import { generatePassphrase } from "./passphrase";
import { parseDuration, SELF_HOSTED_CHUNK_SIZE, uploadToSelfHosted } from "./self-hosted";
import { createShareBundle } from "./site";
import type {
  CFShareBackend,
  CFShareClientOptions,
  CFShareProgress,
  DownloadOptions,
  DownloadResult,
  DownloadToFileOptions,
  ProgressListener,
  SavedDownload,
  ShareOptions,
  ShareResult,
} from "./types";

function isOptionalString(value: string | undefined): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function emit(
  listener: ProgressListener | undefined,
  phase: CFShareProgress["phase"],
  details: Omit<Partial<CFShareProgress>, "phase"> = {},
): void {
  listener?.({ phase, ...details });
}

export class CFShareClient {
  readonly server: string;
  readonly token?: string;
  readonly fetch: typeof fetch;
  readonly backend: CFShareBackend;

  constructor({ server = "drop", token, fetch: fetchImpl = fetch }: CFShareClientOptions = {}) {
    this.server = normalizeServerUrl(server);
    this.token = token;
    this.fetch = fetchImpl;
    this.backend = this.server === "drop" ? "drop" : "self-hosted";
  }

  async share(
    inputPath: string,
    {
      passphrase,
      ttl,
      acceptCloudflareTerms = false,
      token = this.token,
      onProgress,
      retryDelays,
    }: ShareOptions = {},
  ): Promise<ShareResult> {
    const selfHosted = this.backend === "self-hosted";

    if (!selfHosted && ttl != null) {
      throw new Error(
        "Cloudflare Drop shares always expire in one hour; configure a self-hosted server for a custom TTL",
      );
    }

    if (!selfHosted && !acceptCloudflareTerms) {
      throw new Error("Cloudflare Drop requires acceptCloudflareTerms: true");
    }

    if (!isOptionalString(passphrase)) {
      throw new Error("Passphrase must be a string");
    }

    if (passphrase === "") {
      throw new Error("Passphrase cannot be empty");
    }

    const effectivePassphrase = passphrase ?? generatePassphrase();
    const generatedPassphrase = passphrase === undefined ? effectivePassphrase : null;
    const ttlSeconds = selfHosted ? parseDuration(ttl) : undefined;

    const workDir = await mkdtemp(`${tmpdir()}${sep}cfshare-`);

    try {
      emit(onProgress, "preparing", { inputPath: resolve(inputPath) });

      const metadata = await createShareBundle({
        inputPath: resolve(inputPath),
        outputDir: workDir,
        passphrase: effectivePassphrase,
        chunkSize: selfHosted ? SELF_HOSTED_CHUNK_SIZE : undefined,
      });

      emit(onProgress, "prepared", { metadata });

      let result: Omit<ShareResult, "name" | "size">;

      if (selfHosted) {
        emit(onProgress, "uploading", { loaded: 0, total: metadata.storedSize });

        const deployment = await uploadToSelfHosted({
          serverUrl: this.server,
          assetsDir: workDir,
          metadata,
          ttlSeconds,
          token,
          fetchImpl: this.fetch,
          retryDelays,
          onProgress: (loaded, total) => emit(onProgress, "uploading", { loaded, total }),
        });

        result = {
          url: deployment.url,
          expiresAt: deployment.expiresAt,
          backend: "self-hosted",
          claimUrl: null,
          generatedPassphrase,
        };
      } else {
        emit(onProgress, "deploying", { total: metadata.storedSize });

        const deployment = await deployTemporarySite(workDir);

        result = {
          url: deployment.previewUrl,
          expiresAt: metadata.expiresAt,
          backend: "drop",
          claimUrl: deployment.claimUrl ?? null,
          generatedPassphrase,
        };
      }

      const completed = { ...result, name: metadata.name, size: metadata.size };

      emit(onProgress, "complete", {
        url: completed.url,
        expiresAt: completed.expiresAt,
        backend: completed.backend,
        claimUrl: completed.claimUrl,
        name: completed.name,
        size: completed.size,
      });

      return completed;
    } finally {
      await rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  async download(
    url: string | URL,
    { passphrase, onProgress }: DownloadOptions = {},
  ): Promise<DownloadResult> {
    emit(onProgress, "receiving", { loaded: 0 });

    const transfer = await fetchShare(url, {
      passphrase,
      fetchImpl: this.fetch,
      onProgress: (loaded, total) => emit(onProgress, "receiving", { loaded, total }),
    });

    emit(onProgress, "complete", { manifest: transfer.manifest });

    return transfer;
  }

  async downloadToFile(
    url: string | URL,
    { passphrase, output, force = false, onProgress }: DownloadToFileOptions = {},
  ): Promise<SavedDownload> {
    const transfer = await this.download(url, { passphrase, onProgress });

    emit(onProgress, "saving", { output });

    const path = await saveShare({ ...transfer, outputPath: output, force });

    emit(onProgress, "saved", { path, manifest: transfer.manifest });

    return { manifest: transfer.manifest, path };
  }
}

export function createClient(options?: CFShareClientOptions): CFShareClient {
  return new CFShareClient(options);
}
