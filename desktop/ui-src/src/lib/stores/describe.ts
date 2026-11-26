// "Copy kubectl describe" (#513): the object's describe text, as
// `nauvi describe` prints it, on the clipboard.

import { api, visibleCluster } from "../cluster";
import type { ResourceRef } from "../bindings";
import { ClipboardError, copyWhenReady } from "../clipboard";
import { setNotice } from "./actions.svelte";

/** Copy the describe text of an object of this window's context. Call it
 *  from the click (or key) itself: the clipboard write starts there. */
export async function copyDescribe(resource: ResourceRef, namespace: string, name: string) {
  const text = api(visibleCluster()).cmdDescribeResource(resource, namespace, name);
  try {
    await copyWhenReady(text);
    setNotice(true, `Copied the describe of ${resource.kind} ${name}`);
  } catch (e) {
    if (e instanceof ClipboardError) setNotice(false, "Could not copy to the clipboard.");
    else setNotice(false, `Could not describe ${resource.kind} ${name}: ${e instanceof Error ? e.message : String(e)}`);
  }
}
