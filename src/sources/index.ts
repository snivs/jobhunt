import { arbeitnow } from "./arbeitnow.js";
import { ashby, greenhouse, lever } from "./ats.js";
import { hnHiring } from "./hn-hiring.js";
import { remoteok } from "./remoteok.js";
import { remotive } from "./remotive.js";
import type { JobSource } from "./types.js";

/** Registry of adapters. A configured source without an adapter is reported as skipped. */
export const SOURCE_ADAPTERS: Record<string, JobSource> = Object.fromEntries(
  [remotive, remoteok, arbeitnow, hnHiring, greenhouse, lever, ashby].map((s) => [s.key, s]),
);

export function getAdapter(key: string): JobSource | undefined {
  return SOURCE_ADAPTERS[key];
}
