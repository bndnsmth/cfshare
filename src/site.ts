import { basename, extname, join } from "node:path";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { createDirectoryArchive } from "./archive";
import {
  CFSHARE_PROJECT_URL,
  createContentSecurityPolicy,
  DEFAULT_SITE_BRANDING,
  escapeHtml,
  normalizeSiteBranding,
  type SiteBranding,
} from "./branding";
import { encryptBuffer } from "./crypto";
import {
  CFSHARE_FORMAT,
  MAX_FILE_SIZE,
  MAX_TRANSPORT_BYTES,
  PBKDF2_ITERATIONS,
  type CFShareManifest,
  type PayloadDescriptor,
} from "./types";

export const CHUNK_SIZE = 4 * 1024 * 1024;
export const SHARE_LIFETIME_MS = 60 * 60 * 1000;
const MAX_FILE_SIZE_LABEL = `${(MAX_FILE_SIZE / 1024 ** 2).toFixed(1)} MB`;

const MIME_TYPES = new Map<string, string>([
  [".css", "text/css"],
  [".csv", "text/csv"],
  [".gif", "image/gif"],
  [".html", "text/html"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".json", "application/json"],
  [".md", "text/markdown"],
  [".mov", "video/quicktime"],
  [".mp3", "audio/mpeg"],
  [".mp4", "video/mp4"],
  [".pdf", "application/pdf"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".txt", "text/plain"],
  [".webm", "video/webm"],
  [".webp", "image/webp"],
  [".zip", "application/zip"],
]);

async function writeChunks(
  outputDir: string,
  data: Buffer,
  chunkSize: number,
): Promise<PayloadDescriptor[]> {
  const payloads: PayloadDescriptor[] = [];

  for (let offset = 0, index = 0; offset < data.length; offset += chunkSize, index += 1) {
    const chunk = data.subarray(offset, Math.min(offset + chunkSize, data.length));
    const path = `payload-${String(index).padStart(3, "0")}.bin`;

    await writeFile(join(outputDir, path), chunk, { mode: 0o600 });

    payloads.push({ path, size: chunk.length });
  }

  return payloads;
}

export interface CreateShareBundleOptions {
  inputPath: string;
  outputDir: string;
  passphrase: string;
  now?: Date;
  chunkSize?: number;
}

export interface CreateTextShareBundleOptions {
  text: string;
  outputDir: string;
  passphrase: string;
  name?: string;
  now?: Date;
  chunkSize?: number;
}

interface WriteShareBundleOptions {
  source: Buffer;
  name: string;
  kind: "file" | "text";
  outputDir: string;
  passphrase: string;
  now: Date;
  chunkSize: number;
}

async function writeShareBundle({
  source,
  name,
  kind,
  outputDir,
  passphrase,
  now,
  chunkSize,
}: WriteShareBundleOptions): Promise<CFShareManifest> {
  if (!Number.isSafeInteger(chunkSize) || chunkSize <= 0 || chunkSize > MAX_TRANSPORT_BYTES) {
    throw new Error(`Chunk size must be an integer between 1 and ${MAX_TRANSPORT_BYTES} bytes`);
  }

  if (source.length > MAX_FILE_SIZE) {
    throw new Error(`File exceeds cfshare's ${MAX_FILE_SIZE_LABEL} safety limit`);
  }

  if (
    !name ||
    name.length > 1024 ||
    name.includes("/") ||
    name.includes("\\") ||
    Array.from(name).some((character) => character.charCodeAt(0) < 32)
  ) {
    throw new Error("Transfer name must be a filename");
  }

  await mkdir(outputDir, { recursive: true, mode: 0o700 });

  const transformed = await encryptBuffer(source, passphrase);
  const payloads = await writeChunks(outputDir, transformed.data, chunkSize);
  const metadata: CFShareManifest = {
    format: CFSHARE_FORMAT,
    kind,
    name,
    type:
      kind === "text"
        ? "text/plain; charset=utf-8"
        : (MIME_TYPES.get(extname(name).toLowerCase()) ?? "application/octet-stream"),
    size: source.length,
    storedSize: transformed.data.length,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + SHARE_LIFETIME_MS).toISOString(),
    payloads,
    crypto: transformed.crypto,
  };

  await Promise.all([
    writeFile(join(outputDir, "cfshare.json"), `${JSON.stringify(metadata, null, 2)}\n`, {
      mode: 0o600,
    }),
    writeFile(join(outputDir, "index.html"), createLandingPage(), { mode: 0o600 }),
    writeFile(join(outputDir, "_headers"), createHeaders(), { mode: 0o600 }),
  ]);

  return metadata;
}

export async function createShareBundle({
  inputPath,
  outputDir,
  passphrase,
  now = new Date(),
  chunkSize = CHUNK_SIZE,
}: CreateShareBundleOptions): Promise<CFShareManifest> {
  const inputStat = await lstat(inputPath);

  let name: string;
  let source: Buffer;

  if (inputStat.isFile()) {
    if (inputStat.size > MAX_FILE_SIZE) {
      throw new Error(`File exceeds cfshare's ${MAX_FILE_SIZE_LABEL} safety limit`);
    }

    name = basename(inputPath);
    source = await readFile(inputPath);

    if (source.length > MAX_FILE_SIZE) {
      throw new Error(`File exceeds cfshare's ${MAX_FILE_SIZE_LABEL} safety limit`);
    }
  } else if (inputStat.isDirectory()) {
    const archive = await createDirectoryArchive(inputPath, MAX_FILE_SIZE);

    name = archive.name;
    source = archive.data;
  } else if (inputStat.isSymbolicLink()) {
    throw new Error(`Symbolic links cannot be shared: ${inputPath}`);
  } else {
    throw new Error("Only regular files and directories can be shared");
  }

  return writeShareBundle({ source, name, kind: "file", outputDir, passphrase, now, chunkSize });
}

export async function createTextShareBundle({
  text,
  outputDir,
  passphrase,
  name = "shared-text.txt",
  now = new Date(),
  chunkSize = CHUNK_SIZE,
}: CreateTextShareBundleOptions): Promise<CFShareManifest> {
  if (typeof text !== "string") {
    throw new Error("Text must be a string");
  }

  return writeShareBundle({
    source: Buffer.from(text, "utf8"),
    name,
    kind: "text",
    outputDir,
    passphrase,
    now,
    chunkSize,
  });
}

function createHeaders(): string {
  return `/*
  X-Content-Type-Options: nosniff
  Referrer-Policy: no-referrer
  X-Frame-Options: DENY
  Permissions-Policy: camera=(), microphone=(), geolocation=()
  Content-Security-Policy: ${createContentSecurityPolicy(DEFAULT_SITE_BRANDING)}
`;
}

export function createLandingPage(brandingInput: Partial<SiteBranding> = {}): string {
  const branding = normalizeSiteBranding(brandingInput);
  const brandName = escapeHtml(branding.name);
  const favicon = branding.logoUrl
    ? escapeHtml(branding.logoUrl)
    : "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='8' fill='%2311120f'/%3E%3Cpath d='M15 15h25v8H23v18h17v8H15z' fill='%23d9ff43'/%3E%3C/svg%3E";
  const logo = branding.logoUrl
    ? `<img class="brand-logo" src="${escapeHtml(branding.logoUrl)}" alt="">`
    : "";
  const summary = branding.summary
    ? `<p class="brand-summary">${escapeHtml(branding.summary)}</p>`
    : "";

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex, nofollow, noarchive">
  <link rel="icon" href="${favicon}">
  <title>${brandName} - Temporary transfer</title>
  <style>
    :root { --ink:${branding.background}; --paper:${branding.foreground}; --acid:${branding.accent}; --muted:color-mix(in srgb,var(--paper) 62%,var(--ink)); --line:color-mix(in srgb,var(--paper) 24%,var(--ink)); --panel-muted:color-mix(in srgb,var(--ink) 55%,var(--paper)); --danger:#ff5b3d; }
    * { box-sizing: border-box; }
    html, body { min-height: 100%; }
    body { margin:0; color:var(--paper); background:var(--ink); font-family:"IBM Plex Mono","SFMono-Regular",Consolas,monospace; }
    body::before { content:""; position:fixed; inset:0; pointer-events:none; opacity:.17; background-image:repeating-linear-gradient(105deg, transparent 0 34px, color-mix(in srgb,var(--paper) 8%,transparent) 35px, transparent 36px), radial-gradient(circle at 80% 8%, color-mix(in srgb,var(--acid) 25%,transparent), transparent 28%); }
    .shell { position:relative; min-height:100vh; display:grid; grid-template-rows:auto 1fr auto; padding:22px 28px; overflow:hidden; }
    .rail { display:flex; align-items:center; justify-content:space-between; gap:20px; padding-bottom:18px; border-bottom:1px solid var(--line); text-transform:uppercase; letter-spacing:.12em; font-size:11px; }
    .brand { display:flex; align-items:center; gap:10px; color:var(--acid); font-weight:800; }
    .brand span { overflow-wrap:anywhere; }
    .brand-logo { display:block; width:auto; height:28px; max-width:120px; object-fit:contain; }
    .pulse { display:inline-block; width:8px; height:8px; margin-right:8px; border-radius:50%; background:var(--acid); box-shadow:0 0 0 0 color-mix(in srgb,var(--acid) 50%,transparent); animation:pulse 1.8s infinite; }
    main { display:grid; grid-template-columns:minmax(0,1.25fr) minmax(320px,.75fr); gap:7vw; align-items:center; padding:7vh 3vw 9vh; }
    .eyebrow { display:flex; align-items:center; gap:12px; color:var(--acid); font-size:12px; letter-spacing:.16em; text-transform:uppercase; }
    .eyebrow::before { content:""; width:42px; height:2px; background:currentColor; }
    h1 { max-width:800px; margin:24px 0 18px; font-family:"Bodoni 72","Iowan Old Style",Didot,serif; font-size:clamp(64px,9vw,144px); font-weight:400; letter-spacing:-.065em; line-height:.76; }
    .brand-summary { max-width:590px; margin:0 0 10px; color:var(--acid); font-size:12px; font-weight:700; letter-spacing:.08em; line-height:1.5; text-transform:uppercase; }
    .lede { max-width:590px; color:var(--muted); font-size:clamp(14px,1.3vw,18px); line-height:1.7; }
    .panel { position:relative; padding:30px; color:var(--ink); background:var(--paper); box-shadow:16px 16px 0 var(--acid); transform:rotate(-1deg); }
    .panel::after { content:"01H"; position:absolute; top:12px; right:16px; color:var(--panel-muted); font-size:11px; }
    .label { margin:0 0 7px; color:var(--panel-muted); font-size:10px; letter-spacing:.14em; text-transform:uppercase; }
    .filename { margin:0; overflow-wrap:anywhere; font-family:"Bodoni 72","Iowan Old Style",Didot,serif; font-size:clamp(28px,4vw,47px); line-height:1; }
    .facts { display:grid; grid-template-columns:1fr 1fr; margin:28px 0; border-top:1px solid color-mix(in srgb,var(--ink) 35%,var(--paper)); border-bottom:1px solid color-mix(in srgb,var(--ink) 35%,var(--paper)); }
    .fact { padding:14px 0; }
    .fact + .fact { padding-left:18px; border-left:1px solid color-mix(in srgb,var(--ink) 35%,var(--paper)); }
    .value { font-size:13px; }
    form { display:grid; gap:9px; }
    input { width:100%; border:1px solid var(--ink); border-radius:0; padding:15px 14px; color:var(--ink); background:transparent; font:inherit; outline:none; }
    input:focus { box-shadow:inset 0 0 0 2px var(--acid); }
    button { width:100%; border:1px solid var(--ink); border-radius:0; padding:16px; color:var(--paper); background:var(--ink); font:700 12px/1 inherit; letter-spacing:.12em; text-transform:uppercase; cursor:pointer; transition:background .16s,color .16s,transform .16s; }
    button:hover:not(:disabled) { color:var(--ink); background:var(--acid); transform:translate(-3px,-3px); box-shadow:3px 3px 0 var(--ink); }
    button:disabled { cursor:wait; opacity:.65; }
    .message { min-height:20px; margin:12px 0 0; color:var(--panel-muted); font-size:11px; line-height:1.5; }
    .message.error { color:#b42f18; }
    .text-output { max-height:45vh; margin:18px 0 0; padding:16px; overflow:auto; border:1px solid var(--ink); color:var(--ink); background:color-mix(in srgb,var(--paper) 86%,var(--ink)); font:13px/1.65 "IBM Plex Mono","SFMono-Regular",Consolas,monospace; white-space:pre-wrap; overflow-wrap:anywhere; }
    [hidden] { display:none!important; }
    footer { display:flex; flex-wrap:wrap; justify-content:space-between; gap:12px 24px; padding-top:18px; border-top:1px solid var(--line); color:var(--muted); font-size:10px; letter-spacing:.08em; text-transform:uppercase; }
    .project-link { color:inherit; text-underline-offset:3px; }
    .project-link:hover { color:var(--acid); }
    @keyframes pulse { 70% { box-shadow:0 0 0 9px transparent; } 100% { box-shadow:0 0 0 0 transparent; } }
    @keyframes enter { from { opacity:0; transform:translateY(22px); } to { opacity:1; transform:translateY(0); } }
    main > * { animation:enter .7s both cubic-bezier(.2,.7,.2,1); }
    .panel { animation-delay:.12s; }
    @media (max-width:800px) { .shell{padding:18px}.rail>span:last-child{display:none}main{grid-template-columns:1fr;gap:55px;padding:8vh 0 11vh}h1{font-size:clamp(62px,20vw,104px)}.panel{margin-right:13px;padding:24px;box-shadow:10px 10px 0 var(--acid)}footer{line-height:1.5}.footer-detail{display:none} }
    @media (prefers-reduced-motion:reduce) { *,*::before,*::after { animation:none!important; transition:none!important; } }
  </style>
</head>
<body>
  <div class="shell">
    <header class="rail"><span class="brand">${logo}<span>${brandName} // EDGE TRANSFER</span></span><span><i class="pulse"></i>Temporary node online</span><span>Cloudflare network</span></header>
    <main>
      <section>
         <div class="eyebrow">Incoming transmission</div>
         <h1>A file<br>is waiting.</h1>
        ${summary}
         <p class="lede" id="explanation">This transfer expires automatically. The file is assembled and decrypted in your browser; the passphrase never leaves this device.</p>
      </section>
      <section class="panel" aria-labelledby="filename">
        <p class="label">Transfer manifest</p>
        <h2 class="filename" id="filename">Loading manifest...</h2>
        <div class="facts">
          <div class="fact"><p class="label">Payload</p><span class="value" id="size">-</span></div>
          <div class="fact"><p class="label">Self-destruct</p><span class="value" id="expires">-</span></div>
        </div>
        <form id="download-form">
          <label class="label" for="passphrase" id="passphrase-label">Passphrase</label>
          <input id="passphrase" type="password" autocomplete="off" placeholder="Enter the shared phrase">
          <button id="download" type="submit" disabled>Prepare download</button>
        </form>
        <pre class="text-output" id="text-output" tabindex="0" hidden></pre>
        <p class="message" id="message" role="status" aria-live="polite">Reading transfer manifest...</p>
      </section>
    </main>
    <footer><span>AES-256-GCM // Browser decryption</span><a class="project-link" href="${CFSHARE_PROJECT_URL}" target="_blank" rel="noreferrer">Powered by cfshare</a><span class="footer-detail">No account required // Temporary by default</span></footer>
  </div>
  <script>
    const $ = (id) => document.getElementById(id);
    let manifest;

    const formatSize = (bytes) => bytes < 1024 ? bytes + " B" : bytes < 1048576 ? (bytes / 1024).toFixed(1) + " KB" : (bytes / 1048576).toFixed(1) + " MB";
    const decode64 = (value) => {
      const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
      return Uint8Array.from(atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=")), (char) => char.charCodeAt(0));
    };

    const isSafeSize = (value, maximum) => Number.isSafeInteger(value) && value >= 0 && value <= maximum;
    const isPayloadPath = (value) => typeof value === "string" && value.length > 0 && value.length <= 1024 && !value.startsWith("/") && !value.includes("\\\\") && !value.split("/").includes("..") && !/^[a-z][a-z\\d+.-]*:/i.test(value);

    function validateManifest(candidate) {
      if (!candidate || candidate.format !== "${CFSHARE_FORMAT}" || (candidate.kind !== undefined && candidate.kind !== "file" && candidate.kind !== "text") || typeof candidate.name !== "string" || candidate.name.length === 0 || candidate.name.length > 1024 || candidate.name.includes("/") || candidate.name.includes("\\\\") || Array.from(candidate.name).some((character) => character.charCodeAt(0) < 32) || typeof candidate.type !== "string" || candidate.type.length === 0 || candidate.type.length > 255) {
        throw new Error("Unsupported transfer format");
      }

      if (!isSafeSize(candidate.size, ${MAX_FILE_SIZE}) || !isSafeSize(candidate.storedSize, ${MAX_FILE_SIZE + 16}) || !Array.isArray(candidate.payloads) || candidate.payloads.length === 0 || candidate.payloads.length > 1000) {
        throw new Error("Invalid transfer manifest");
      }

      if (typeof candidate.createdAt !== "string" || typeof candidate.expiresAt !== "string" || !Number.isFinite(Date.parse(candidate.createdAt)) || !Number.isFinite(Date.parse(candidate.expiresAt)) || Date.parse(candidate.expiresAt) <= Date.parse(candidate.createdAt)) {
        throw new Error("Invalid transfer timestamps");
      }

      let total = 0;
      for (const payload of candidate.payloads) {
        if (!payload || !isPayloadPath(payload.path) || !isSafeSize(payload.size, ${MAX_FILE_SIZE + 16}) || new URL(payload.path, location.href).origin !== location.origin) {
          throw new Error("Invalid payload descriptor");
        }

        total += payload.size;
      }

      if (total !== candidate.storedSize || candidate.crypto?.algorithm !== "AES-GCM" || candidate.crypto?.kdf !== "PBKDF2" || candidate.crypto?.hash !== "SHA-256" || candidate.crypto?.iterations !== ${PBKDF2_ITERATIONS} || !/^[A-Za-z0-9_-]{22}$/.test(candidate.crypto?.salt || "") || !/^[A-Za-z0-9_-]{16}$/.test(candidate.crypto?.iv || "")) {
        throw new Error("Unsupported encryption format");
      }

      return candidate;
    }

    async function readPayload(response, expectedSize) {
      const contentLength = response.headers.get("Content-Length");
      if (contentLength !== null && Number(contentLength) !== expectedSize) {
        throw new Error("A payload chunk has an unexpected size");
      }

      if (!response.body) {
        throw new Error("A payload chunk has no response body");
      }

      const reader = response.body.getReader();
      const chunks = [];
      let size = 0;

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          size += value.byteLength;
          if (size > expectedSize) {
            throw new Error("A payload chunk exceeds its declared size");
          }
          chunks.push(value);
        }
      } catch (error) {
        await reader.cancel(error).catch(() => {});
        throw error;
      }

      if (size !== expectedSize) {
        throw new Error("A payload chunk is incomplete");
      }

      const joined = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        joined.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return joined;
    }

    async function loadPayload() {
      const chunks = [];
      let loaded = 0;

      for (const payload of manifest.payloads) {
        const response = await fetch(payload.path, { cache: "no-store" });

        if (!response.ok) {
          throw new Error("A payload chunk is unavailable");
        }

        const chunk = await readPayload(response, payload.size);

        chunks.push(chunk);
        loaded += chunk.length;
        $("message").textContent = "Receiving " + Math.round((loaded / (manifest.storedSize || 1)) * 100) + "%";
      }

      const joined = new Uint8Array(loaded);
      let offset = 0;

      for (const chunk of chunks) {
        joined.set(chunk, offset);
        offset += chunk.length;
      }

      return joined;
    }

    async function decrypt(data, passphrase) {
      const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(passphrase), "PBKDF2", false, ["deriveKey"]);
      const key = await crypto.subtle.deriveKey({ name:"PBKDF2", salt:decode64(manifest.crypto.salt), iterations:manifest.crypto.iterations, hash:"SHA-256" }, material, { name:"AES-GCM", length:256 }, false, ["decrypt"]);
      return crypto.subtle.decrypt({ name:"AES-GCM", iv:decode64(manifest.crypto.iv) }, key, data);
    }

    function save(data) {
      const url = URL.createObjectURL(new Blob([data], { type:manifest.type }));
      const link = document.createElement("a");

      link.href = url;
      link.download = manifest.name;
      link.click();

      setTimeout(() => URL.revokeObjectURL(url), 30000);
    }

    function revealText(data) {
      const output = $("text-output");
      output.textContent = new TextDecoder("utf-8", { fatal:true }).decode(data);
      $("download-form").hidden = true;
      output.hidden = false;
      output.focus();
    }

    function updateClock() {
      const remaining = new Date(manifest.expiresAt).getTime() - Date.now();

      if (remaining <= 0) {
        $("expires").textContent = "expired";
        return;
      }

      const minutes = Math.ceil(remaining / 60000);

      $("expires").textContent = minutes + " min";
    }

    async function initialize() {
      const response = await fetch("./cfshare.json", { cache:"no-store" });

      if (!response.ok) {
        throw new Error("Transfer manifest is unavailable");
      }

      manifest = validateManifest(await response.json());

      $("filename").textContent = manifest.name;
      $("size").textContent = formatSize(manifest.size);
      if (manifest.kind === "text") {
        document.querySelector("h1").innerHTML = "A note<br>is waiting.";
        $("explanation").textContent = "This note expires automatically. It is assembled and decrypted in your browser; the passphrase never leaves this device.";
        $("download").textContent = "Reveal text";
      }
      updateClock();
      setInterval(updateClock, 30000);
      $("download").disabled = false;
      $("message").textContent = manifest.kind === "text" ? "Encrypted text. The phrase stays in this page." : "Encrypted file. The phrase stays in this page.";
    }

    $("download-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      const button = $("download");
      const message = $("message");

      message.className = "message";

      if (!$("passphrase").value) {
        message.textContent = "Enter the passphrase to continue.";
        message.classList.add("error");
        return;
      }

      button.disabled = true;

      try {
        const payload = await loadPayload();

        message.textContent = "Decrypting locally...";

        const data = await decrypt(payload, $("passphrase").value);

        if (data.byteLength !== manifest.size) {
          throw new Error("Decrypted file size does not match the manifest");
        }

        if (manifest.kind === "text") {
          revealText(data);
          message.textContent = "Text revealed locally.";
        } else {
          save(data);
          message.textContent = "Download ready. This tab can be closed.";
        }
      } catch (error) {
        message.textContent = "Wrong passphrase, expired link, or damaged transfer.";
        message.classList.add("error");
      } finally {
        button.disabled = false;
      }
    });

    initialize().catch((error) => {
      $("message").textContent = error.message;
      $("message").classList.add("error");
    });
  </script>
</body>
</html>
`;
}
