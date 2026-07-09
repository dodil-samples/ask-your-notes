/**
 * The action registry — one flat name → function map, grouped by domain file.
 *
 * Tiers are declared in lib/gate.ts (PUBLIC_ACTIONS); this module only says what
 * exists. actions/ = WHAT the product does, lib/ = HOW it talks to the world.
 */

import { K3 } from "../lib/k3.ts";
import type { Json } from "./common.ts";
import * as gate from "../lib/gate.ts";
import {
  backlinks,
  deleteNote,
  exportVault,
  getNote,
  graph,
  listNotes,
  publicOverview,
  putNote,
  reindex,
  tags,
} from "./notes.ts";
import { ask, search } from "./search.ts";

export const ACTIONS: Record<string, (k3: K3, p: Json) => Promise<Json>> = {
  // -- PUBLIC (anon-safe: reading the vault) --
  search,
  ask,
  get_note: getNote,
  list_notes: listNotes,
  backlinks,
  tags,
  graph,
  public_overview: publicOverview,
  // -- PRIVATE (admin key: editing the vault) --
  put_note: putNote,
  delete_note: deleteNote,
  reindex,
  export: exportVault,
  create_key: gate.createKey,
  list_keys: gate.listKeys,
  revoke_key: gate.revokeKey,
};
