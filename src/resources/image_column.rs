//! The Image column of Pods and workloads (#547): the first container's
//! image, short, with how many more there are; the full references for
//! the cell's tooltip. Init containers are not counted.
//!
//! The cell is plain text: the first line is what the cell shows, each
//! line after it one container's full reference (with the digest it runs,
//! for a pod whose status has one):
//!
//! ```text
//! mongo:7.0.1 +1
//! docker.io/library/mongo:7.0.1@sha256:…
//! ghcr.io/org/exporter:2
//! ```

use super::jsonpath::array_at;
use crate::image_ref::{digest_of_image_id, ImageRef};
use crate::text::one_line;
use serde_json::Value;

/// A reference longer than this is cut (they are a few hundred at most).
const MAX_REF: usize = 300;

fn cell(refs: Vec<ImageRef>) -> String {
    let Some(first) = refs.first() else {
        return String::new();
    };
    // Cluster text: each line made safe to show, and kept to one line.
    let mut lines = vec![one_line(&first.short(), MAX_REF)];
    if refs.len() > 1 {
        lines[0].push_str(&format!(" +{}", refs.len() - 1));
    }
    lines.extend(refs.iter().map(|r| one_line(&r.full(), MAX_REF)));
    lines.join("\n")
}

fn images_at(v: &Value, pointer: &str) -> Vec<ImageRef> {
    array_at(v, pointer)
        .filter_map(|c| c.get("image").and_then(Value::as_str))
        .map(ImageRef::parse)
        .collect()
}

/// A pod's images, with the digest each container runs when its status
/// says and the spec does not pin one.
pub(super) fn pod_images(v: &Value) -> String {
    let statuses: Vec<&Value> = array_at(v, "/status/containerStatuses").collect();
    let refs = array_at(v, "/spec/containers")
        .filter_map(|c| {
            let mut r = ImageRef::parse(c.get("image").and_then(Value::as_str)?);
            let name = c.get("name").and_then(Value::as_str);
            let running = statuses
                .iter()
                .find(|s| s.get("name").and_then(Value::as_str) == name)
                .and_then(|s| s.get("imageID").and_then(Value::as_str))
                .and_then(digest_of_image_id);
            if let (true, Some(d)) = (r.digest.is_empty(), running) {
                r.digest = d.to_string();
            }
            Some(r)
        })
        .collect();
    cell(refs)
}

/// A Deployment's, StatefulSet's, DaemonSet's, ReplicaSet's or Job's
/// images, from its pod template.
pub(super) fn template_images(v: &Value) -> String {
    cell(images_at(v, "/spec/template/spec/containers"))
}

/// A CronJob's images, from its job template.
pub(super) fn cronjob_images(v: &Value) -> String {
    cell(images_at(
        v,
        "/spec/jobTemplate/spec/template/spec/containers",
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn pod_cell_shows_the_first_image_and_lists_all() {
        let digest = format!("sha256:{}", "0f".repeat(32));
        let pod = json!({
            "spec": {
                "initContainers": [{"name": "init", "image": "busybox"}],
                "containers": [
                    {"name": "db", "image": "mongo:7.0.1"},
                    {"name": "exporter", "image": "ghcr.io/org/exporter:2"}
                ]
            },
            "status": {"containerStatuses": [
                {"name": "db", "imageID": format!("docker.io/library/mongo@{digest}")}
            ]}
        });
        assert_eq!(
            pod_images(&pod),
            format!(
                "mongo:7.0.1 +1\ndocker.io/library/mongo:7.0.1@{digest}\nghcr.io/org/exporter:2"
            )
        );
        assert_eq!(pod_images(&json!({"spec": {}})), "");
    }

    #[test]
    fn workload_cells_read_their_templates() {
        let deploy = json!({"spec": {"template": {"spec": {"containers": [
            {"name": "web", "image": "nginx"}
        ]}}}});
        assert_eq!(
            template_images(&deploy),
            "nginx:latest\ndocker.io/library/nginx"
        );
        let cron = json!({"spec": {"jobTemplate": {"spec": {"template": {"spec": {
            "containers": [{"name": "a", "image": "alpine:3"}, {"name": "b", "image": "alpine:3"}]
        }}}}}});
        assert_eq!(
            cronjob_images(&cron),
            "alpine:3 +1\ndocker.io/library/alpine:3\ndocker.io/library/alpine:3"
        );
    }

    #[test]
    fn hostile_text_stays_on_its_line() {
        let pod =
            json!({"spec": {"containers": [{"name": "a", "image": "evil\u{202e}\n:1\u{1b}[2J"}]}});
        let text = pod_images(&pod);
        assert_eq!(text.lines().count(), 2, "{text:?}");
        assert!(
            !text.contains('\u{202e}') && !text.contains('\u{1b}'),
            "{text:?}"
        );
    }
}
