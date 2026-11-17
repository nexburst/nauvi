//! The local files logging in to a context sends (#244): a `tokenFile`
//! goes out as the bearer token, a `client-certificate` and `client-key`
//! as the TLS identity. For an added kubeconfig, those outside its own
//! folder may be files it was never meant to see (a service account token,
//! the user's own certificate), so the catalog checks such a context only
//! when the user asks, and says which files it reads.

use kube::config::{AuthInfo, Kubeconfig};
use std::path::Path;

/// The `tokenFile`, `client-certificate` and `client-key` of `auth` that
/// are outside `folder` (or cannot be resolved), as the kubeconfig names
/// them once made absolute ([`Kubeconfig::read_from`] does that).
///
/// Paths are compared after resolving symbolic links and `..`, so a link
/// in the folder to a file elsewhere counts as outside. A file that does
/// not exist (yet) counts as outside too.
pub fn local_files_outside(auth: &AuthInfo, folder: &Path) -> Vec<String> {
    let folder = std::fs::canonicalize(folder).ok();
    let mut out: Vec<String> = Vec::new();
    for path in [&auth.token_file, &auth.client_certificate, &auth.client_key]
        .into_iter()
        .flatten()
    {
        let inside = match (&folder, std::fs::canonicalize(path)) {
            (Some(folder), Ok(real)) => real.starts_with(folder),
            _ => false,
        };
        if !inside && !out.contains(path) {
            out.push(path.clone());
        }
    }
    out
}

/// [`local_files_outside`] for `context` of `kubeconfig`, read from
/// `file`: the files outside the file's own folder (`[]`: none, or no such
/// context or user).
pub fn context_local_files(kubeconfig: &Kubeconfig, context: &str, file: &Path) -> Vec<String> {
    let folder = file.parent().unwrap_or(Path::new(""));
    kubeconfig
        .contexts
        .iter()
        .find(|c| c.name == context)
        .and_then(|c| c.context.as_ref())
        .and_then(|c| c.user.as_deref())
        .and_then(|user| kubeconfig.auth_infos.iter().find(|a| a.name == user))
        .and_then(|a| a.auth_info.as_ref())
        .map(|auth| local_files_outside(auth, folder))
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    struct Dir(PathBuf);
    impl Drop for Dir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// `<tmp>/<tag>/team/team.yaml` with `user`, next to `team/crt.pem`,
    /// `team/key.pem` and `<tmp>/<tag>/elsewhere/token`.
    fn written(tag: &str, user: &str) -> (Dir, PathBuf) {
        let root =
            std::env::temp_dir().join(format!("nauvi-244-local-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let team = root.join("team");
        std::fs::create_dir_all(&team).unwrap();
        std::fs::create_dir_all(root.join("elsewhere")).unwrap();
        std::fs::write(team.join("crt.pem"), "CRT").unwrap();
        std::fs::write(team.join("key.pem"), "KEY").unwrap();
        std::fs::write(root.join("elsewhere/token"), "TOKEN").unwrap();
        let file = team.join("team.yaml");
        std::fs::write(
            &file,
            format!(
                "apiVersion: v1\nkind: Config\nclusters:\n- name: c\n  cluster: {{server: \"https://x.example\"}}\n\
                 users:\n- name: u\n  user:\n{user}\ncontexts:\n- name: one\n  context: {{cluster: c, user: u}}\n"
            ),
        )
        .unwrap();
        (Dir(root), file)
    }

    fn files_of(tag: &str, user: &str) -> (Dir, Vec<String>) {
        let (dir, file) = written(tag, user);
        let kc = Kubeconfig::read_from(&file).unwrap();
        (dir, context_local_files(&kc, "one", &file))
    }

    #[test]
    fn files_next_to_the_kubeconfig_are_not_listed() {
        let (_dir, files) = files_of(
            "inside",
            "    client-certificate: crt.pem\n    client-key: ./key.pem",
        );
        assert_eq!(files, Vec::<String>::new());
    }

    #[test]
    fn files_elsewhere_are_listed_in_order() {
        let (dir, files) = files_of(
            "outside",
            "    tokenFile: ../elsewhere/token\n    client-certificate: crt.pem\n    client-key: ../gone/key.pem",
        );
        let at = |p: &str| dir.0.join("team").join(p).display().to_string();
        assert_eq!(files, vec![at("../elsewhere/token"), at("../gone/key.pem")]);
    }

    #[test]
    fn an_inline_token_reads_no_file() {
        let (_dir, files) = files_of("inline", "    token: abc");
        assert!(files.is_empty());
        let kc = Kubeconfig::from_yaml("apiVersion: v1\nkind: Config\n").unwrap();
        assert!(context_local_files(&kc, "missing", Path::new("/x/kc")).is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn a_link_out_of_the_folder_is_outside() {
        let (dir, file) = written("link", "    tokenFile: token");
        std::os::unix::fs::symlink(dir.0.join("elsewhere/token"), dir.0.join("team/token"))
            .unwrap();
        let kc = Kubeconfig::read_from(&file).unwrap();
        let files = context_local_files(&kc, "one", &file);
        assert_eq!(files, vec![dir.0.join("team/token").display().to_string()]);
    }
}
