import { webcrypto } from "node:crypto";

// Some Node 22 installations disable the global Web Crypto alias. The shared
// FUS module uses the standard global, which already exists in Workers.
if (!globalThis.crypto) globalThis.crypto = webcrypto;
