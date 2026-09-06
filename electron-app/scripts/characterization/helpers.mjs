// Returns the system temp directory (Windows: %TEMP%) without importing
// node:os under a name some bundlers stub.
import os from "node:os";

export function osTempDir() {
  return os.tmpdir();
}
