import { lstat, readdir } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import type { Readable } from "node:stream";
import type { ZipFile } from "yazl";

const YAZL_PACKAGE = "yazl";

function formatLimit(maxBytes: number): string {
  return `${(maxBytes / 1024 ** 2).toFixed(1)} MiB`;
}

export interface DirectoryArchive {
  data: Buffer;
  name: string;
}

async function addDirectory(
  zipFile: ZipFile,
  diskPath: string,
  archivePath: string,
  maxBytes: number,
  total: { value: number },
): Promise<void> {
  const directoryStat = await lstat(diskPath);

  if (!directoryStat.isDirectory()) {
    throw new Error(`Expected a directory: ${diskPath}`);
  }

  zipFile.addEmptyDirectory(`${archivePath}/`, {
    mtime: directoryStat.mtime,
    mode: directoryStat.mode,
  });

  const entries = await readdir(diskPath, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));

  for (const entry of entries) {
    const childDiskPath = join(diskPath, entry.name);
    const childArchivePath = `${archivePath}/${entry.name}`;
    const childStat = await lstat(childDiskPath);

    if (childStat.isSymbolicLink()) {
      throw new Error(`Symbolic links cannot be shared: ${childDiskPath}`);
    }

    if (childStat.isDirectory()) {
      await addDirectory(zipFile, childDiskPath, childArchivePath, maxBytes, total);
      continue;
    }

    if (!childStat.isFile()) {
      throw new Error(`Unsupported directory entry: ${childDiskPath}`);
    }

    total.value += childStat.size;
    if (total.value > maxBytes) {
      throw new Error(`Directory contents exceed cfshare's ${formatLimit(maxBytes)} safety limit`);
    }

    zipFile.addFile(childDiskPath, childArchivePath, {
      mtime: childStat.mtime,
      mode: childStat.mode,
    });
  }
}

function collectArchive(zipFile: ZipFile, maxBytes: number): Promise<Buffer> {
  return new Promise((resolvePromise, rejectPromise) => {
    const chunks: Buffer[] = [];
    let size = 0;
    // SAFETY: yazl documents outputStream as a Node readable stream; its declarations are broader.
    const output = zipFile.outputStream as Readable;

    zipFile.once("error", rejectPromise);
    output.once("error", rejectPromise);
    output.on("data", (chunk: Buffer) => {
      size += chunk.length;

      if (size > maxBytes) {
        output.destroy(
          new Error(`Generated ZIP exceeds cfshare's ${formatLimit(maxBytes)} safety limit`),
        );
        return;
      }

      chunks.push(chunk);
    });
    output.once("end", () => resolvePromise(Buffer.concat(chunks, size)));

    zipFile.end();
  });
}

export async function createDirectoryArchive(
  inputPath: string,
  maxBytes: number,
): Promise<DirectoryArchive> {
  const { ZipFile } = (await import(YAZL_PACKAGE)) as typeof import("yazl");
  const zipFile = new ZipFile();
  const rootName = basename(resolve(inputPath)) || "archive";
  const name = /\.zip$/i.test(rootName) ? rootName : `${rootName}.zip`;

  await addDirectory(zipFile, inputPath, rootName, maxBytes, { value: 0 });

  return { data: await collectArchive(zipFile, maxBytes), name };
}
