/**
 * Ask-Your-Notes — Ignite (Deno) entrypoint.
 *
 * The Deno runtime invokes the function via the `ignite` SDK's `start(handler)`.
 * The dispatch entrypoint is ./handler.ts (SDK-independent, so it can be unit-run
 * with plain `deno run` / `deno task smoke`); this file is only the wiring.
 */

import { start } from "ignite";
import { handle } from "./handler.ts";

start(handle);
