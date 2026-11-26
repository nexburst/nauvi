//! The images of a workload's pod template, for its panel's Available tags.

use serde::Serialize;
use serde_json::Value;

/// One container of a pod template and its image.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct ContainerImage {
    pub container: String,
    pub image: String,
    /// `regular`, `init` or `ephemeral`, as in the pod panel.
    pub kind: String,
}

/// The containers of `obj`'s pod template: `spec.template.spec` of a
/// Deployment, StatefulSet, DaemonSet, ReplicaSet or Job,
/// `spec.jobTemplate.spec.template.spec` of a CronJob. Empty for other
/// kinds.
pub fn workload_images(obj: &Value) -> Vec<ContainerImage> {
    let pod = obj
        .pointer("/spec/template/spec")
        .or_else(|| obj.pointer("/spec/jobTemplate/spec/template/spec"));
    let Some(pod) = pod else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for (field, kind) in [("initContainers", "init"), ("containers", "regular")] {
        for c in pod.get(field).and_then(Value::as_array).into_iter().flatten() {
            let (Some(name), Some(image)) = (
                c.get("name").and_then(Value::as_str),
                c.get("image").and_then(Value::as_str),
            ) else {
                continue;
            };
            out.push(ContainerImage {
                container: name.into(),
                image: image.into(),
                kind: kind.into(),
            });
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn reads_templates_of_workloads_and_cronjobs() {
        let deploy = json!({"spec": {"template": {"spec": {
            "initContainers": [{"name": "migrate", "image": "app:1.0"}],
            "containers": [{"name": "web", "image": "nginx:1.27"}, {"name": "noimage"}],
        }}}});
        let imgs = workload_images(&deploy);
        assert_eq!(imgs.len(), 2);
        assert_eq!((imgs[0].container.as_str(), imgs[0].kind.as_str()), ("migrate", "init"));
        assert_eq!(imgs[1].image, "nginx:1.27");
        let cron = json!({"spec": {"jobTemplate": {"spec": {"template": {"spec": {
            "containers": [{"name": "job", "image": "busybox:1.36"}],
        }}}}}});
        assert_eq!(workload_images(&cron)[0].image, "busybox:1.36");
        assert!(workload_images(&json!({"spec": {}})).is_empty());
    }
}
