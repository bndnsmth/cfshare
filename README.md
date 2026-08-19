# ☁️ cfshare

> **Send encrypted files, folders, or plain text with one command.**
>
> Zero-configuration file handoffs for humans and coding agents.

`cfshare` encrypts your content locally and publishes the ciphertext as a temporary Cloudflare site. You get a browser-ready link and a passphrase to send separately.

```sh
npx cfshare ./demo.zip
```

Share text directly or pipe it from another command. Newlines, including a trailing newline, are preserved:

```sh
cfshare text $'first line\nsecond line'
printf 'first line\nsecond line\n' | cfshare text
```

```txt
🔗 Share URL:  https://cfshare-a1b2c3d4e5.example.workers.dev
🔑 Passphrase: bakiro-femado-joveki-nasito-rigape-wopime
   Send this separately.
```

The recipient opens the link and decrypts the download on their device. Cloudflare never receives the unencrypted contents, passphrase, or key.

Drop links expire after about an hour. No Cloudflare account. No storage bucket. No backend to configure.

> [!TIP]
> **Agent-friendly Drop mode.** Coding agents can hand off logs, screenshots, archives, and generated artifacts through a CLI they already know how to use. After reviewing Cloudflare's [Terms](https://www.cloudflare.com/terms/) and [Privacy Policy](https://www.cloudflare.com/privacypolicy/), add `--yes --json` for a non-interactive, machine-readable result:
>
> ```sh
> npx cfshare ./artifact.zip --yes --json
> ```
>
> The JSON includes the generated passphrase. Treat the complete result as a secret.

Drop is ideal for occasional transfers. Deploy the included backend for your own domain, authenticated uploads, and configurable expiration.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/bndnsmth/cfshare)

> [!NOTE]
> `cfshare` is an independent project and is not affiliated with or endorsed by Cloudflare.

## Cloudflare Drop Mode

[Cloudflare Drop](https://www.cloudflare.com/drop/) normally publishes a folder as a temporary static site. `cfshare` uses that mechanism to publish an encrypted file transfer instead.

Cloudflare thinks you deployed a website. Your recipient gets an encrypted, expiring download.

Before deploying, `cfshare` builds a folder like this:

```txt
index.html          download and browser decryption UI
cfshare.json        transfer and encryption metadata
payload-000.bin     encrypted file bytes
payload-001.bin
...
```

It runs the equivalent of:

```sh
wrangler deploy <that-folder> --temporary
```

This uses the same preview-account and static-assets mechanism as Drop; it does not automate the Drop web page. `cfshare` removes normal Cloudflare credentials from the Wrangler process, deploys an isolated temporary site, and returns its public URL.

Drop limits each static asset to 5 MiB, so `cfshare` splits the ciphertext into 4 MiB pieces. The generated page fetches the pieces, rejoins them in memory, decrypts the file with Web Crypto, and starts the download. The passphrase never goes to Cloudflare.

## Encryption Overview

Every transfer uses:

- AES-256-GCM for authenticated encryption
- PBKDF2-HMAC-SHA-256 with 600,000 iterations
- A random 128-bit salt
- A random 96-bit IV

Encryption happens before the file leaves your machine. The recipient derives the same non-exportable key in their browser. A wrong phrase or changed ciphertext fails authentication.

If you do not supply a phrase, `cfshare` generates six pronounceable parts from Node's cryptographic RNG. The result carries 108 bits of entropy and is returned with the share for you to send separately.

```txt
bakiro-femado-joveki-nasito-rigape-wopime
```

Want your own phrase instead?

```sh
# Hidden prompt
cfshare ./demo.zip --password

# Automation
CFSHARE_PASSWORD='a long unique phrase' cfshare ./demo.zip
```

Only payload contents are encrypted. Filename, MIME type, size, timestamps, chunk sizes, salt, and IV remain visible. Folder paths stay inside the encrypted ZIP.

## Backend Comparison

|                       | Drop                           | Your Worker                  |
| --------------------- | ------------------------------ | ---------------------------- |
| Setup                 | None                           | Deploy once                  |
| Cloudflare account    | Not required                   | Required                     |
| Expiration            | About 1 hour                   | 10 seconds to 30 days        |
| URL                   | Temporary `workers.dev` domain | Your Worker or custom domain |
| Storage               | Temporary static assets        | One Durable Object per share |
| Sender gate           | Cloudflare policy acceptance   | `UPLOAD_TOKEN` required      |
| Recipient requirement | Browser and passphrase         | Browser and passphrase       |

Both modes accept files and folders. Folders are always recursive and download as `<folder>.zip`; symbolic links are rejected. Source contents and the generated ZIP must fit the 250 MiB safety limit.

## CLI

Requires Node.js 22.18 or newer.

```sh
# Generate a phrase and a one-hour Drop link
npx cfshare ./demo.zip

# Recursively ZIP and share a folder
npx cfshare ./photos

# Supply your own phrase through a hidden prompt
npx cfshare ./demo.zip --password

# Receive through the CLI instead of a browser
npx cfshare get https://example.workers.dev --password
npx cfshare get https://example.workers.dev -o ./demo.zip
```

Drop use requires accepting [Cloudflare's Terms](https://www.cloudflare.com/terms/) and [Privacy Policy](https://www.cloudflare.com/privacypolicy/). The CLI prompts interactively. Use `--yes` only after reviewing both:

```sh
cfshare ./demo.zip --yes --json
```

When a phrase is generated, `--json` includes `generatedPassphrase`. Treat the complete output as a secret.

```txt
cfshare <path> [options]
cfshare send <path> [options]
cfshare text [value] [options]
cfshare get <url> [options]
cfshare config set server <url|drop>
cfshare config unset server
cfshare config show
```

| Send option               | Purpose                                       |
| ------------------------- | --------------------------------------------- |
| `-p, --password[=phrase]` | Use your own phrase; omit the value to prompt |
| `-y, --yes`               | Accept Cloudflare policies non-interactively  |
| `--json`                  | Print machine-readable output                 |
| `--server <url\|drop>`    | Override the configured backend               |
| `--ttl <duration>`        | Set self-hosted expiration                    |
| `--token <token>`         | Set upload token; prefer `CFSHARE_TOKEN`      |

`cfshare text` reads from stdin when no value is provided. Browser recipients reveal text in the page; `cfshare get` writes text shares directly to stdout and continues to save file shares to disk.

| Get option                | Purpose                              |
| ------------------------- | ------------------------------------ |
| `-p, --password[=phrase]` | Decrypt; omit the value to prompt    |
| `-o, --output <path>`     | Choose the destination               |
| `-f, --force`             | Replace an existing destination file |

Install globally if you use it often:

```sh
npm install --global cfshare
```

## Self-Hosted Deployment

The included Worker stores each encrypted share in one randomly named Durable Object. Uploads are streamed in segments, the object verifies every byte, and public downloads leave as one `ReadableStream`. An alarm deletes the object's storage at expiration; requests also enforce the timestamp if the alarm runs late.

No R2, KV, D1, wildcard DNS, or per-share route is required.

The same Worker can also run on the open-source [celld](https://celld.dev) runtime. See the [celld deployment guide](docs/celld-docs.md) for the compatible config, deployment steps, and end-to-end verification.

For a one-click setup, use **Deploy to Cloudflare** above. Cloudflare clones the repository into your GitHub or GitLab account, prompts for a unique `UPLOAD_TOKEN`, provisions the Durable Object, deploys the Worker, and configures builds for future pushes.

To deploy manually instead:

```sh
npm install
npx wrangler login
npm run worker:deploy
```

Create the required upload token:

```sh
export CFSHARE_TOKEN="$(openssl rand -hex 32)"
printf '%s' "$CFSHARE_TOKEN" | \
  vp exec wrangler secret put UPLOAD_TOKEN
```

Point the CLI at the returned origin:

```sh
cfshare config set server https://cfshare-worker.example.workers.dev
cfshare ./demo.zip --ttl 12h
```

Use a custom domain by adding this to `wrangler.jsonc` before deploying:

```json
{
  "routes": [{ "pattern": "share.example.com", "custom_domain": true }]
}
```

```sh
cfshare config set server https://share.example.com
cfshare ./demo.zip --ttl 2d
```

Supported duration suffixes are `s`, `m`, `h`, and `d`. Defaults and limits live in the `vars` block of `wrangler.jsonc`.

### Branding

Self-hosted Worker pages can use light deployment-level branding. Set these values in the `vars` block of `wrangler.jsonc` before deploying:

```jsonc
{
  "vars": {
    "BRAND_NAME": "Acme Secure Transfer",
    "BRAND_SUMMARY": "Private file delivery for Acme clients and partners.",
    "BRAND_LOGO_URL": "https://acme.example/logo.svg",
    "BRAND_BACKGROUND": "#101820",
    "BRAND_FOREGROUND": "#f7f4ed",
    "BRAND_ACCENT": "#ffb81c",
  },
}
```

The logo is optional and must use HTTPS. Colors must be six-digit hex values. Invalid settings safely fall back to the default cfshare branding. These values affect the Worker home page and every transfer it serves; Cloudflare Drop transfers retain the standard cfshare appearance.

Return to Drop with `cfshare config unset server` or use `--server drop` for one transfer. `CFSHARE_SERVER` overrides saved configuration, and `--server` overrides both.

## Node.js Client

The ESM client powers the CLI and is also public.

```ts
import { createClient } from "cfshare";

const cfshare = createClient();
const share = await cfshare.share("./demo.zip", {
  acceptCloudflareTerms: true,
});

const note = await cfshare.shareText("first line\nsecond line\n", {
  acceptCloudflareTerms: true,
});

console.log(share.url);
console.log(share.generatedPassphrase);
console.log(note.url);
```

Pass a directory path to recursively ZIP it before encryption.

Provide `passphrase` to use your own. In that case, `generatedPassphrase` is `null` so your secret is not copied into results.

Self-hosted:

```ts
const cfshare = createClient({
  server: "https://share.example.com",
  token: process.env.CFSHARE_TOKEN,
});

const share = await cfshare.share("./demo.zip", {
  passphrase: process.env.CFSHARE_PASSWORD,
  ttl: "12h",
});
```

Download into memory or to disk:

```ts
const { manifest, data } = await cfshare.download(share.url, {
  passphrase: share.generatedPassphrase ?? process.env.CFSHARE_PASSWORD,
});

const saved = await cfshare.downloadToFile(share.url, {
  passphrase: share.generatedPassphrase ?? process.env.CFSHARE_PASSWORD,
  output: "./received.zip",
  force: true,
});
```

The library does not read CLI config or environment variables implicitly. Pass `server`, `token`, and `passphrase` yourself.

## Security Notes

- Send the URL and passphrase through different channels.
- Anyone with both can download repeatedly until expiration.
- Generated phrases are strong; user-provided phrases may be guessed offline.
- AES-GCM authenticates file contents, not manifest metadata or sender identity.
- Recipients trust the hosting origin to serve the unmodified browser decryptor.
- Payloads are encrypted and decrypted in memory; 250 MiB is the safety limit.
- Expiration is logical deletion, not forensic secure erasure.
- `cfshare` has not undergone an independent security audit.

## Development

```sh
npm install
npm run check
npm test
npm run build
node ./dist/cfshare.js --help
```

## License

MIT.
