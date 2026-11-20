//! What the off-by-default Pod columns (#378, #379) cost a 5,000-pod table.
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
/// an IP (no nominated node: only preempting pods have one), and an init
/// container and a sidecar for the Containers cell.
fn pod(i: usize) -> DynamicObject {
    serde_json::from_value(json!({
        "apiVersion": "v1", "kind": "Pod",
        "metadata": {
            "name": format!("web-7d9f8b6c5d-{i:05}"), "namespace": "shop",
            "creationTimestamp": "2026-11-01T10:00:00Z",
            "ownerReferences": [{"apiVersion": "apps/v1", "kind": "ReplicaSet",
                                 "name": "web-7d9f8b6c5d", "controller": true}]
        },
        "spec": {
            "nodeName": "worker-3",
            "initContainers": [{"name": "migrate"}],
            "containers": [{"name": "app"}, {"name": "istio-proxy"}]
        },
        "status": {
            "phase": "Running", "qosClass": "Burstable",
            "podIP": format!("10.244.{}.{}", i / 250, i % 250),
            "initContainerStatuses": [{"name": "migrate", "ready": false,
                "state": {"terminated": {"exitCode": 0, "reason": "Completed"}}}],
            "containerStatuses": [
                {"name": "app", "ready": true, "restartCount": 0, "state": {"running": {}}},
                {"name": "istio-proxy", "ready": true, "restartCount": 0, "state": {"running": {}}}
            ]
        }
    }))
    .unwrap()
}

/// Heap of a row's cells: the `String`s and their text.
fn cells_heap(row: &ResourceRow) -> usize {
    row.cells.capacity() * std::mem::size_of::<String>()
        + row.cells.iter().map(String::capacity).sum::<usize>()
}

/// What `with` costs over `without` at [`PODS`] pods: heap of the cells in
/// the core, bytes of JSON to the page.
fn extra(r: &ResourceRef, with: &[ColumnDef], without: &[ColumnDef]) -> (usize, usize) {
    let (mut heap, mut json) = (0, 0);
    for i in 0..PODS {
        let obj = pod(i);
        let a = make_row(r, with, &obj);
        let b = make_row(r, without, &obj);
        heap += cells_heap(&a) - cells_heap(&b);
        json += serde_json::to_vec(&a).unwrap().len() - serde_json::to_vec(&b).unwrap().len();
    }
    (heap, json)
}

#[test]
fn optional_pod_columns_cost_at_5k_pods() {
    let r = rref("", "Pod", "pods", true);
    let all = columns_for(&r, &[]);
    let default: Vec<_> = all.iter().filter(|c| !c.default_hidden).cloned().collect();
    assert_eq!(all.len() - default.len(), 5);
    let no_containers: Vec<_> = all
        .iter()
        .filter(|c| c.key != "containers")
        .cloned()
        .collect();

    // #378: Controlled By, QoS, IP, Nominated Node.
    let (heap, json) = extra(&r, &no_containers, &default);
    println!(
        "#378 pod columns at {PODS} pods: +{heap} B of cells in the core ({} B a pod), \
         +{json} B of JSON to the page ({} B a pod)",
        heap / PODS,
        json / PODS
    );
    // Measured: 157 B a pod of cells (0.8 MB, twice that with the batcher's
    // copy) and 58 B of JSON, against the growth budget's 30 MB for the
    // core's rows of a 5,000-object table (#397).
    assert!(heap < 1_000_000, "{heap} B of cells");
    assert!(json < 500_000, "{json} B of JSON");

    // #379: Containers, for an init container and two containers.
    let (heap, json) = extra(&r, &all, &no_containers);
    println!(
        "Containers column at {PODS} pods: +{heap} B of cells in the core ({} B a pod), \
         +{json} B of JSON to the page ({} B a pod)",
        heap / PODS,
        json / PODS
    );
    // Measured: 69 B a pod of cells (0.35 MB) and 48 B of JSON
    // (`init:migrate=done app=ready istio-proxy=ready`).
    assert!(heap < 500_000, "{heap} B of cells");
    assert!(json < 300_000, "{json} B of JSON");
}
