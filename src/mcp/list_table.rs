//! The `list` tool's table (#377): the kind's columns like `kubectl get`,
//! pods with a LAST column (the newest termination), then only the
//! `columns` asked for, or the `compact` set.

use super::problems::last_termination_cell;
use crate::resources::{self, align_columns, ResourceKind};
use anyhow::{anyhow, Result};
use kube::api::DynamicObject;

/// The table of `objects`, sorted like `kubectl get`.
pub fn list_table(
    kind: &ResourceKind,
    objects: &[DynamicObject],
    columns: Option<&[String]>,
    compact: bool,
    one_namespace: bool,
) -> Result<String> {
    let is_pod = kind.resource.group.is_empty() && kind.resource.kind == "Pod";
    let now = jiff::Timestamp::now().as_second();
    let mut header = resources::table_header(kind);
    // LAST goes after RESTARTS (or at the end).
    let last_at = header
        .iter()
        .position(|h| h == "RESTARTS")
        .map_or(header.len(), |i| i + 1);
    if is_pod {
        header.insert(last_at, "LAST".into());
    }
    let keep = shown_columns(&header, columns, compact, one_namespace)?;
    let mut rows: Vec<_> = objects
        .iter()
        .map(|o| {
            let row = resources::make_row(&kind.resource, &kind.columns, o);
            let mut cells = resources::table_cells(kind, &row);
            if is_pod {
                let v = serde_json::to_value(o).unwrap_or_default();
                cells.insert(last_at.min(cells.len()), last_termination_cell(&v, now));
            }
            (row.key, cells)
        })
        .collect();
    rows.sort_by(|a, b| a.0.cmp(&b.0));
    let mut table = vec![keep.iter().map(|&i| header[i].clone()).collect::<Vec<_>>()];
    for (_, cells) in rows {
        table.push(
            keep.iter()
                .map(|&i| cells.get(i).cloned().unwrap_or_default())
                .collect(),
        );
    }
    Ok(align_columns(&table))
}

/// The indexes of `header` to print: the `columns` named (any case, in
/// their order), or all but NODE (and NAMESPACE for one namespace) when
/// `compact`, else all.
pub fn shown_columns(
    header: &[String],
    columns: Option<&[String]>,
    compact: bool,
    one_namespace: bool,
) -> Result<Vec<usize>> {
    if let Some(wanted) = columns.filter(|c| !c.is_empty()) {
        return wanted
            .iter()
            .map(|w| {
                let w = w.trim().to_uppercase();
                header.iter().position(|h| *h == w).ok_or_else(|| {
                    let names: Vec<_> = header.iter().map(|h| h.to_lowercase()).collect();
                    anyhow!(
                        "no column {}; this kind has {}",
                        w.to_lowercase(),
                        names.join(", ")
                    )
                })
            })
            .collect();
    }
    Ok((0..header.len())
        .filter(|&i| {
            !compact || (header[i] != "NODE" && !(one_namespace && header[i] == "NAMESPACE"))
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn header() -> Vec<String> {
        [
            "NAME",
            "NAMESPACE",
            "READY",
            "STATUS",
            "RESTARTS",
            "LAST",
            "NODE",
            "AGE",
        ]
        .map(String::from)
        .to_vec()
    }

    #[test]
    fn all_columns_by_default() {
        assert_eq!(
            shown_columns(&header(), None, false, true).unwrap(),
            (0..8).collect::<Vec<_>>()
        );
    }

    #[test]
    fn compact_drops_node_and_the_one_namespace() {
        assert_eq!(
            shown_columns(&header(), None, true, true).unwrap(),
            [0, 2, 3, 4, 5, 7]
        );
        // All namespaces: the namespace says which pod is which.
        assert_eq!(
            shown_columns(&header(), None, true, false).unwrap(),
            [0, 1, 2, 3, 4, 5, 7]
        );
    }

    #[test]
    fn named_columns_in_their_order() {
        let cols = ["name", "Restarts", "last", "age"].map(String::from);
        assert_eq!(
            shown_columns(&header(), Some(&cols), true, true).unwrap(),
            [0, 4, 5, 7]
        );
        let err = shown_columns(&header(), Some(&["ip".into()]), false, false).unwrap_err();
        assert!(
            err.to_string()
                .starts_with("no column ip; this kind has name, namespace"),
            "{err}"
        );
    }
}
