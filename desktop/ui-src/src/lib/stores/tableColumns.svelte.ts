// What a resource table's columns are (#547): the kind's own and the
// custom ones that apply in this context, and the Columns chooser's
// "open" request from a header's right-click menu.

import type { CustomColumn, ResourceKind } from "../bindings";
import { customFor, withCustom } from "../customColumns";
import { currentContextName } from "./app.svelte";
import { kindSettings } from "./settings.svelte";

/** The custom columns of `kind` shown here (a CRD's: this context's). */
export function tableCustom(kind: ResourceKind): CustomColumn[] {
  return customFor(kindSettings(kind.id).custom, kind, currentContextName());
}

/** `kind` with its custom columns, as the table and the chooser use it. */
export function tableKind(kind: ResourceKind): ResourceKind {
  return withCustom(kind, tableCustom(kind));
}

/** Bumped to open the Columns chooser of the kind `kindId`. */
export const chooserRequest = $state({ nonce: 0, kindId: "" });

export function openColumnChooser(kindId: string) {
  chooserRequest.kindId = kindId;
  chooserRequest.nonce++;
}
