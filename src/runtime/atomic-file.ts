import { writeFile, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";

/** Callers own their queue/lock; this only prevents partially written files. */
export async function atomicWrite(path: string, bytes: string | Buffer) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, bytes, { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}
