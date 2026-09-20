import dotenv from "dotenv";
import { fileURLToPath } from "node:url";

// Match index.ts's configuration precedence before applying the development default.
// The production entry keeps its own initialization and 0.0.0.0 fallback.
dotenv.config({ path: fileURLToPath(new URL("../../../.env", import.meta.url)), quiet: true });
dotenv.config({ quiet: true });
process.env.API_HOST ??= "127.0.0.1";

// Static imports would start the server before the development default is set.
await import("./index.js");
