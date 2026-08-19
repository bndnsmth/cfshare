# cfshare on celld

This guide runs cfshare's existing Worker and Durable Object on
[celld](https://celld.dev), with one SQLite-backed cell per encrypted share.
No application code fork is required.

## Compatibility

- `celld deploy` builds the same Worker entrypoint used on Cloudflare.
- Each random share ID addresses an independent Durable Object and SQLite database.
- Encrypted payload upload, browser download, and expiry alarms work unchanged.
- The fleet's deployment and cell replicas live in an S3-compatible or GCS bucket.

celld is currently alpha software. Read its
[limitations](https://celld.dev/docs/limitations) and
[security guidance](https://celld.dev/docs/security) before exposing a fleet.

## Run on celld

Install cfshare's dependencies, celld, and an `esbuild` binary:

```sh
npm install
curl -fsSL https://celld.dev/install.sh | sh
export PATH="$HOME/.local/bin:$PWD/node_modules/.bin:$PATH"
```

Point celld at a bucket that supports conditional writes. For Cloudflare R2:

```sh
export AWS_ACCESS_KEY_ID=...
export AWS_SECRET_ACCESS_KEY=...
export AWS_REGION=auto
export S3_ENDPOINT=https://ACCOUNT_ID.r2.cloudflarestorage.com
export CELLD_BUCKET=s3://cfshare-celld
```

Deploy the Worker:

```sh
celld deploy wrangler.celld.jsonc
```

Configure a TLS ingress to forward the public hostname to `127.0.0.1:8080`,
then start the node with that HTTPS origin. The upload token and public origin
are injected only at runtime and are not written into the deployment stored in
the bucket.

```sh
export CELLD_VAR_UPLOAD_TOKEN="$(openssl rand -hex 32)"
export CELLD_VAR_PUBLIC_ORIGIN=https://share.example.com
celld --listen 127.0.0.1:8080
```

Use the HTTPS origin to exercise the complete flow:

```sh
ORIGIN=https://share.example.com
printf 'hello from a celld Durable Object\n' > /tmp/cfshare-celld.txt
CFSHARE_TOKEN="$CELLD_VAR_UPLOAD_TOKEN" \
  node ./dist/cfshare.js /tmp/cfshare-celld.txt --server "$ORIGIN" --ttl 10m --json
```

Open the returned share URL and enter the generated passphrase, or verify it
from the CLI:

```sh
node ./dist/cfshare.js get SHARE_URL --password=GENERATED_PASSPHRASE \
  --output /tmp/cfshare-celld.received.txt
cmp /tmp/cfshare-celld.txt /tmp/cfshare-celld.received.txt
```

Run the celld node with a persistent `CELLD_WATCH` volume, terminate TLS at a
load balancer or ingress proxy, and never expose celld's internal listener.
