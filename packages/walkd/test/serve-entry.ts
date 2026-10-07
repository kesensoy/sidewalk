// Test-only stand-in for bin/walkd.js, so cli.test.ts can drive the CLI under
// tsx without a build. Like bin/walkd.js, it is an ENTRY: it calls main()
// itself, because cli.ts no longer self-runs on being imported.
import { main } from "../src/cli.js";
await main();
