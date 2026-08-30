import crypto from "crypto";
import fs from "fs";
import path from "path";

export async function downloadSubtitleForMpv({ subtitleUrl, format, signal, userDataPath }) {
  const cacheRoot = path.join(userDataPath, "subtitle-cache");
  const extension = ["ass", "ssa"].includes(String(format || "").toLowerCase()) ? ".ass" : ".vtt";
  const digest = crypto.createHash("sha256").update(subtitleUrl).digest("hex");
  const cachedPath = path.join(cacheRoot, `${digest}${extension}`);
  try {
    const stat = await fs.promises.stat(cachedPath);
    if (stat.isFile() && stat.size > 0 && stat.size <= 5 * 1024 * 1024) {
      return { filePath: cachedPath, cached: true };
    }
  } catch {}

  const response = await fetch(subtitleUrl, { signal, headers: { Accept: "text/vtt, text/plain, text/x-ssa" } });
  if (!response.ok) {
    const retryAfter = response.headers.get("retry-after");
    const suffix = retryAfter ? `; retry after ${retryAfter}s` : "";
    throw new Error(`Subtitle download returned ${response.status}${suffix}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.length || bytes.length > 5 * 1024 * 1024) {
    throw new Error("Subtitle file is empty or too large");
  }

  await fs.promises.mkdir(cacheRoot, { recursive: true });
  const temporaryPath = `${cachedPath}.${process.pid}.tmp`;
  await fs.promises.writeFile(temporaryPath, bytes);
  try {
    await fs.promises.rename(temporaryPath, cachedPath);
  } catch (error) {
    await fs.promises.rm(temporaryPath, { force: true }).catch(() => {});
    try {
      const stat = await fs.promises.stat(cachedPath);
      if (!stat.isFile() || stat.size <= 0) throw error;
    } catch {
      throw error;
    }
  }
  return { filePath: cachedPath, cached: false };
}
