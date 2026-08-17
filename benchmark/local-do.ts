import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { cpus, platform, release, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";
import { createShareBundle } from "../src/site.ts";
import { fetchShare } from "../src/download.ts";
import { generatePassphrase } from "../src/passphrase.ts";
import { SELF_HOSTED_CHUNK_SIZE, uploadToSelfHosted } from "../src/self-hosted.ts";

const require = createRequire(import.meta.url);
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const wranglerCli = require.resolve("wrangler");
const wranglerPackage: { version: string } = require("wrangler/package.json");
const workerdPackage: { version: string } = require("workerd/package.json");
const wranglerVersion = wranglerPackage.version;
const workerdVersion = workerdPackage.version;
const sizesMiB = (process.env.BENCH_SIZES ?? "1,10,25")
  .split(",")
  .map((value) => Number(value.trim()));
const runs = Number(process.env.BENCH_RUNS ?? 5);
const port = Number(process.env.BENCH_PORT ?? 8820);
const uploadToken = "cfshare-local-benchmark";

interface RunOptions {
  sizeMiB: number;
  sourcePath: string;
  sourceHash: string;
  serverUrl: string;
  root: string;
  iteration: string | number;
}

interface Measurement {
  packMs: number;
  uploadMs: number;
  downloadMs: number;
  deleteMs: number;
  segments: number;
}

function summarize(values: number[]) {
  const sorted = [...values].sort((left, right) => left - right);

  if (sorted.length === 0) {
    throw new Error("Cannot summarize an empty measurement set");
  }

  return {
    median: sorted[Math.floor(sorted.length / 2)],
    min: sorted[0],
    max: sorted.at(-1) ?? sorted[0],
  };
}

async function stopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null) {
    return;
  }

  await new Promise<void>((resolvePromise) => {
    const forceKill = setTimeout(() => child.kill("SIGKILL"), 5_000);

    child.once("close", () => {
      clearTimeout(forceKill);
      resolvePromise();
    });
    child.kill("SIGTERM");
  });
}

function formatMs(value: number): string {
  return value.toFixed(1);
}

function formatRate(sizeMiB: number, milliseconds: number): string {
  return (sizeMiB / (milliseconds / 1000)).toFixed(1);
}

async function waitForServer(
  url: string,
  child: ChildProcessWithoutNullStreams,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Wrangler exited before becoming ready (${child.exitCode})`);
    }

    try {
      const response = await fetch(`${url}/health`);

      if (response.ok) {
        return;
      }
    } catch {}

    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }

  throw new Error("Timed out waiting for Wrangler dev");
}

async function runOne({
  sizeMiB,
  sourcePath,
  sourceHash,
  serverUrl,
  root,
  iteration,
}: RunOptions): Promise<Measurement> {
  const bundlePath = join(root, `bundle-${sizeMiB}-${iteration}`);
  const passphrase = generatePassphrase();
  const packStarted = performance.now();

  const metadata = await createShareBundle({
    inputPath: sourcePath,
    outputDir: bundlePath,
    chunkSize: SELF_HOSTED_CHUNK_SIZE,
    passphrase,
  });
  const packMs = performance.now() - packStarted;

  const uploadStarted = performance.now();
  const deployment = await uploadToSelfHosted({
    serverUrl,
    assetsDir: bundlePath,
    metadata,
    ttlSeconds: 3600,
    token: uploadToken,
  });
  const uploadMs = performance.now() - uploadStarted;

  const downloadStarted = performance.now();
  const downloaded = await fetchShare(deployment.url, { passphrase });
  const downloadMs = performance.now() - downloadStarted;
  const downloadedHash = createHash("sha256").update(downloaded.data).digest("hex");

  if (downloadedHash !== sourceHash) {
    throw new Error(`Hash mismatch for ${sizeMiB} MiB run ${iteration}`);
  }

  const deleteStarted = performance.now();
  const deleteResponse = await fetch(
    `${serverUrl}/api/shares/${new URL(deployment.url).pathname.split("/")[1]}`,
    {
      method: "DELETE",
      headers: { Authorization: `Bearer ${uploadToken}` },
    },
  );
  const deleteMs = performance.now() - deleteStarted;

  if (!deleteResponse.ok) {
    throw new Error(`Delete failed with HTTP ${deleteResponse.status}`);
  }

  await rm(bundlePath, { recursive: true, force: true });

  return { packMs, uploadMs, downloadMs, deleteMs, segments: metadata.payloads.length };
}

async function main(): Promise<void> {
  if (!Number.isInteger(runs) || runs < 1) {
    throw new Error("BENCH_RUNS must be a positive integer");
  }

  if (sizesMiB.some((size) => !Number.isInteger(size) || size < 1 || size > 250)) {
    throw new Error("BENCH_SIZES must be comma-separated integers between 1 and 250 MiB");
  }

  const root = await mkdtemp(join(tmpdir(), "cfshare-benchmark-"));
  const serverUrl = `http://127.0.0.1:${port}`;
  const workerLog: string[] = [];
  let child: ChildProcessWithoutNullStreams | undefined;

  try {
    await mkdir(join(root, "persist"), { recursive: true });

    child = spawn(
      process.execPath,
      [
        wranglerCli,
        "dev",
        "--config",
        join(projectRoot, "wrangler.jsonc"),
        "--var",
        `UPLOAD_TOKEN:${uploadToken}`,
        "--persist-to",
        join(root, "persist"),
        "--port",
        String(port),
        "--log-level",
        "error",
      ],
      {
        cwd: projectRoot,
        env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    child.stdin.end();

    const collectLog = (chunk: Buffer): void => {
      workerLog.push(chunk.toString());
    };

    child.stdout.on("data", collectLog);
    child.stderr.on("data", collectLog);
    await waitForServer(serverUrl, child);

    console.log(`cfshare local streamed Durable Object benchmark`);
    console.log(`Node ${process.version}; Wrangler ${wranglerVersion}; workerd ${workerdVersion}`);
    console.log(`${platform()} ${release()} ${process.arch}; ${cpus()[0]?.model ?? "unknown CPU"}`);
    console.log(
      `${runs} measured runs per size; one unmeasured 1 MiB warmup; streamed 50 MiB transport segments\n`,
    );

    const warmupPath = join(root, "warmup.bin");
    const warmupData = randomBytes(1024 * 1024);
    await writeFile(warmupPath, warmupData);
    await runOne({
      sizeMiB: 1,
      sourcePath: warmupPath,
      sourceHash: createHash("sha256").update(warmupData).digest("hex"),
      serverUrl,
      root,
      iteration: "warmup",
    });

    const rows: Record<string, string | number>[] = [];
    for (const sizeMiB of sizesMiB) {
      const sourcePath = join(root, `source-${sizeMiB}.bin`);
      let source: Buffer | null = randomBytes(sizeMiB * 1024 * 1024);
      const sourceHash = createHash("sha256").update(source).digest("hex");

      await writeFile(sourcePath, source);

      source = null;

      const measurements: Measurement[] = [];

      for (let iteration = 1; iteration <= runs; iteration += 1) {
        process.stderr.write(`\r${sizeMiB} MiB: run ${iteration}/${runs}`);
        measurements.push(
          await runOne({ sizeMiB, sourcePath, sourceHash, serverUrl, root, iteration }),
        );
      }
      process.stderr.write("\r\x1b[2K");

      const pack = summarize(measurements.map(({ packMs }) => packMs));
      const upload = summarize(measurements.map(({ uploadMs }) => uploadMs));
      const download = summarize(measurements.map(({ downloadMs }) => downloadMs));
      const deletion = summarize(measurements.map(({ deleteMs }) => deleteMs));
      rows.push({
        size: `${sizeMiB} MiB`,
        segments: measurements[0]?.segments ?? 0,
        packMedianMs: formatMs(pack.median),
        uploadMedianMs: formatMs(upload.median),
        uploadMiBs: formatRate(sizeMiB, upload.median),
        downloadMedianMs: formatMs(download.median),
        downloadMiBs: formatRate(sizeMiB, download.median),
        deleteMedianMs: formatMs(deletion.median),
        uploadRangeMs: `${formatMs(upload.min)}-${formatMs(upload.max)}`,
        downloadRangeMs: `${formatMs(download.min)}-${formatMs(download.max)}`,
      });
    }

    console.table(rows);
    console.log("All downloads matched their source SHA-256 hash.");
  } catch (error) {
    if (workerLog.length) {
      process.stderr.write(`\nWrangler output:\n${workerLog.join("")}\n`);
    }

    throw error;
  } finally {
    if (child && child.exitCode === null) {
      await stopChild(child);
    }

    await rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
