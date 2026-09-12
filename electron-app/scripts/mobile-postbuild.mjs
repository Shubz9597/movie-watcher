// Mobile bundle post-build (M1.4.2): Capacitor requires index.html at the
// webDir root; our multi-entry build emits mobile.html. Rename deterministically.
import { renameSync, existsSync, unlinkSync } from "node:fs";

const from = "dist-mobile/mobile.html";
const to = "dist-mobile/index.html";
if (existsSync(from)) {
  if (existsSync(to)) unlinkSync(to);
  renameSync(from, to);
  console.log("[mobile-postbuild] mobile.html -> index.html");
} else if (!existsSync(to)) {
  console.error("[mobile-postbuild] no mobile.html/index.html in dist-mobile");
  process.exit(1);
}
