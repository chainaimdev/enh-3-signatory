// Frozen evidence for unit tests (2026-11-14): copy of UI/data/signatory-evidence.json at commit 38e4df7
// (INV-2026-0003 … 0016). Tests must not depend on the live export, which changes on every 4D / Phase B run.
// Public data only (the same file was committed in git); no keys or passcodes.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const FIXTURE_EVIDENCE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "signatory-evidence.fixture.json");
