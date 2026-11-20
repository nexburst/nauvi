//! What the off-by-default Pod columns (#378) cost a 5,000-pod table.
//!
//! A table watch keeps only the rows (#397), and every row carries a cell
//! for every column, shown or not, so the four optional columns are paid
//! for by every Pods table. This measures that cost on rows like the ones
//! the core keeps and sends: the cells' heap in the core and the JSON the
//! page receives.

use super::columns::columns_for;
use super::test_support::rref;
use super::*;
use kube::api::DynamicObject;
use serde_json::json;

const PODS: usize = 5_000;

/// A Deployment's pod, with what a running pod has: an owner, a QoS class,
/// an IP (no nominated node: only preempting pods have one).
fn pod(i: usize) -> DynamicObject {
    serde_json::from_value(json!({
        "apiVersion": "v1", "kind": "Pod",
        "metadata": {
            "name": format!("web-7d9f8b6c5d-{i:05}"), "namespace": "shop",
            "creationTimestamp": "2026-11-01T10:00:00Z",
            "ownerReferences": [{"apiVersion": "apps/v1", "kind": "ReplicaSet",
                                 "name": "web-7d9f8b6c5d", "controller": true}]
        },
        "spec": { "nodeName": "worker-3", "containers": [{"name": "app"}] },
        "status": {
            "phase": "Running", "qosClass": "Burstable",
            "podIP": format!("10.244.{}.{}", i / 250, i % 250),
            "containerStatuses": [{"ready": true, "restartCount": 0,
                                   "state": {"running": {}}}]
        }
    }))
    .unwrap()
}

/// Heap of a row's cells: the `String`s and their text.
fn cells_heap(row: &ResourceRow) -> usize {
    row.cells.capacity() * std::mem::size_of::<String>()
        + row.cells.iter().map(String::capacity).sum::<usize>()
}

#[test]
fn optional_pod_columns_cost_at_5k_pods() {
    let r = rref("", "Pod", "pods", true);
    let all = columns_for(&r, &[]);
    let default: Vec<_> = all.iter().filter(|c| !c.default_hidden).cloned().collect();
    assert_eq!(all.len() - default.len(), 4);

    let (mut heap_all, mut heap_default, mut json_all, mut json_default) = (0, 0, 0, 0);
    for i in 0..PODS {
        let obj = pod(i);
        let with = make_row(&r, &all, &obj);
        let without = make_row(&r, &default, &obj);
        heap_all += cells_heap(&with);
        heap_default += cells_heap(&without);
        json_all += serde_json::to_vec(&with).unwrap().len();
        json_default += serde_json::to_vec(&without).unwrap().len();
    }
    let heap = heap_all - heap_default;
    let json = json_all - json_default;
    println!(
        "optional pod columns at {PODS} pods: +{heap} B of cells in the core \
         ({} B a pod, {heap_default} B without them), +{json} B of JSON to the page \
         ({} B a pod, {json_default} B without them)",
        heap / PODS,
        json / PODS
    );
    // Measured: 157 B a pod of cells (0.8 MB, twice that with the batcher's
    // copy) and 58 B of JSON, against the growth budget's 30 MB for the
    // core's rows of a 5,000-object table (#397).
    assert!(heap < 1_000_000, "{heap} B of cells");
    assert!(json < 500_000, "{json} B of JSON");
}
