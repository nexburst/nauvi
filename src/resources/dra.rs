//! Table cells of the Dynamic Resource Allocation kinds (`resource.k8s.io`):
//! DeviceClasses, ResourceClaims and their templates. Pure functions of the
//! object.

use super::columns::abbreviate;
use super::jsonpath::{array_at, path_str};
use serde_json::Value;

/// `Pending`, `Allocated` or `Reserved` (allocated and in use by a pod), or
/// `Deleting`, like the STATE column of `kubectl get resourceclaims`.
pub(super) fn claim_state(v: &Value) -> String {
    if v.pointer("/metadata/deletionTimestamp").is_some() {
        "Deleting"
    } else if array_at(v, "/status/reservedFor").next().is_some() {
        "Reserved"
    } else if v.pointer("/status/allocation").is_some() {
        "Allocated"
    } else {
        "Pending"
    }
    .into()
}

/// The consumers a claim is reserved for: `pods/web-0`.
pub(super) fn reserved_for(v: &Value) -> String {
    let names: Vec<String> = array_at(v, "/status/reservedFor")
        .map(|r| format!("{}/{}", path_str(r, ".resource"), path_str(r, ".name")))
        .collect();
    abbreviate(names)
}

/// The requests of a claim template: `gpu (gpu.example.com)`. The class is
/// under `exactly` in v1 and on the request itself in v1beta1.
pub(super) fn template_requests(v: &Value) -> String {
    let reqs: Vec<String> = array_at(v, "/spec/spec/devices/requests")
        .map(|r| {
            let name = path_str(r, ".name");
            let class = match path_str(r, ".exactly.deviceClassName") {
                c if c.is_empty() => path_str(r, ".deviceClassName"),
                c => c,
            };
            if class.is_empty() {
                name
            } else {
                format!("{name} ({class})")
            }
        })
        .collect();
    abbreviate(reqs)
}

/// How many CEL selectors a DeviceClass has.
pub(super) fn selectors(v: &Value) -> String {
    array_at(v, "/spec/selectors").count().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn claim_state_follows_allocation_and_reservation() {
        assert_eq!(claim_state(&json!({})), "Pending");
        assert_eq!(
            claim_state(&json!({"status": {"allocation": {}}})),
            "Allocated"
        );
        let reserved = json!({"status": {"allocation": {},
            "reservedFor": [{"resource": "pods", "name": "web-0", "uid": "1"}]}});
        assert_eq!(claim_state(&reserved), "Reserved");
        assert_eq!(reserved_for(&reserved), "pods/web-0");
        assert_eq!(
            claim_state(&json!({"metadata": {"deletionTimestamp": "x"}})),
            "Deleting"
        );
        assert_eq!(reserved_for(&json!({})), "");
    }

    #[test]
    fn template_requests_name_their_class_in_v1_and_v1beta1() {
        let t = json!({"spec": {"spec": {"devices": {"requests": [
            {"name": "gpu", "exactly": {"deviceClassName": "gpu.example.com"}},
            {"name": "nic", "deviceClassName": "nic.example.com"},
            {"name": "any"},
        ]}}}});
        assert_eq!(
            template_requests(&t),
            "gpu (gpu.example.com),nic (nic.example.com),any"
        );
    }

    #[test]
    fn selectors_counts_cel_expressions() {
        let c = json!({"spec": {"selectors": [{"cel": {"expression": "true"}}]}});
        assert_eq!(selectors(&c), "1");
        assert_eq!(selectors(&json!({})), "0");
    }
}
