//! Command-line arguments of the `nauvi` binary (not part of the
//! library).

use clap::{Parser, Subcommand};
use clap_complete::Shell;
use nauvi::helm::HelmSection;
use nauvi::OutputFormat;
use std::path::PathBuf;

#[derive(Parser, Debug)]
#[command(name = "nauvi", version, about = "A Lens alternative written in Rust")]
pub struct Cli {
    /// Kubeconfig context to use (default: the current context)
    #[arg(long, global = true, value_name = "NAME")]
    pub context: Option<String>,
    /// Kubeconfig file to read (default: KUBECONFIG, then ~/.kube/config)
    #[arg(long, global = true, value_name = "PATH")]
    pub kubeconfig: Option<PathBuf>,
    #[command(subcommand)]
    pub command: Commands,
}

#[derive(Subcommand, Debug)]
pub enum Commands {
    /// List pods (all namespaces by default)
    Pods {
        /// Only list pods in this namespace
        #[arg(short, long)]
        namespace: Option<String>,
    },
    /// List namespaces
    Namespaces,
    /// List or show any resource type, including CRDs (like kubectl get)
    Get {
        /// Resource type: plural, kind or short name (deploy, svc,
        /// widgets.example.com), or `<kind>/<name>` for one object
        kind: String,
        /// Show only this object
        name: Option<String>,
        /// Only list this namespace (default: all namespaces; for one named
        /// object, the context's namespace)
        #[arg(short, long)]
        namespace: Option<String>,
        /// List all namespaces (the default; accepted for kubectl habits)
        #[arg(short = 'A', long, conflicts_with = "namespace")]
        all_namespaces: bool,
        /// Output format
        #[arg(short, long, value_enum, default_value_t = OutputFormat::Table)]
        output: OutputFormat,
        /// Label selector, e.g. `app=web,tier!=db`
        #[arg(short = 'l', long)]
        selector: Option<String>,
        /// Field selector, e.g. `status.phase=Running`
        #[arg(long)]
        field_selector: Option<String>,
        /// Show Secret values in yaml and json output
        #[arg(long)]
        reveal: bool,
    },
    /// Show one object of any kind like kubectl describe: metadata, owners,
    /// labels, conditions and events
    Describe {
        /// `<kind>/<name>`, or the kind followed by the name
        target: String,
        /// The object's name, when the kind is given on its own
        name: Option<String>,
        /// Namespace (default: the context's namespace)
        #[arg(short, long)]
        namespace: Option<String>,
    },
    /// Only what is wrong, and why: crash-looping, failed, not ready or
    /// pending pods, recent restarts, workloads short of replicas, failed
    /// Jobs, not-ready Nodes, lost PVCs (the same findings as the MCP
    /// `problems` tool)
    Problems {
        /// Only this namespace (default: all namespaces)
        #[arg(short, long)]
        namespace: Option<String>,
        /// All namespaces (the default; accepted for kubectl habits)
        #[arg(short = 'A', long, conflicts_with = "namespace")]
        all_namespaces: bool,
        /// Only these kinds (pods, deployments, statefulsets, daemonsets,
        /// replicasets, jobs, nodes, persistentvolumeclaims); repeat or
        /// separate with commas
        #[arg(short, long = "kind", value_delimiter = ',', value_name = "KIND")]
        kinds: Vec<String>,
        /// At most this many rows
        #[arg(long, default_value_t = nauvi::problems::DEFAULT_PROBLEMS)]
        limit: usize,
    },
    /// Serve the Model Context Protocol on stdio for AI assistants
    /// (read-only unless --allow-writes)
    Mcp {
        /// Also offer the tools that change the cluster: scale, restart,
        /// delete and apply (RBAC still applies). `apply` can create
        /// workloads that read Secrets; `delete` of a Namespace or CRD
        /// deletes everything under it
        #[arg(long)]
        allow_writes: bool,
        /// The kubeconfig file the context comes from in the app, for its
        /// read-only or protected mode (for a client started from an app
        /// terminal, whose KUBECONFIG starts with a per-terminal file)
        #[arg(long, value_name = "PATH", hide = true)]
        mode_file: Option<PathBuf>,
    },
    /// Stream live changes to any resource type (until Ctrl-C)
    Watch {
        /// What to watch: pods, nodes, deployments, a CRD, ...
        #[arg(default_value = "pods")]
        resource: String,
        /// Only watch this namespace
        #[arg(short, long)]
        namespace: Option<String>,
    },
    /// List nodes
    Nodes,
    /// Show the last lines of a pod's logs, or of every pod of a workload
    Logs {
        /// Pod name, or `deploy/<name>`, `sts/<name>`, `ds/<name>`, `job/<name>`
        /// to merge the logs of all its pods (`[pod] line`)
        name: String,
        /// Pod namespace
        #[arg(short, long)]
        namespace: Option<String>,
        /// Number of lines from the end of the logs
        #[arg(long, default_value_t = 200)]
        tail: i64,
        /// Container name (including init containers); default container if omitted
        #[arg(short, long)]
        container: Option<String>,
        /// Show the logs of the previous (crashed) container instance
        #[arg(short, long)]
        previous: bool,
        /// Stream new log lines until interrupted
        #[arg(short, long)]
        follow: bool,
    },
    /// Show the newer tags of an image in its registry: newer patch, minor
    /// and major versions with the same variant (`7.0.1-jammy` ->
    /// `7.0.2-jammy`). Reads the registry over HTTPS, anonymously or with
    /// your docker credentials (`docker login`); it does not use the
    /// cluster
    Tags {
        /// The image, e.g. `mongo:7.0.1` or `ghcr.io/org/app:v1.2.3`
        image: String,
        /// The `imageID` a pod reports for it
        /// (`docker.io/library/mongo@sha256:…`): says whether the tag was
        /// pushed again since
        #[arg(long, value_name = "ID")]
        image_id: Option<String>,
        /// Print JSON instead of text
        #[arg(long)]
        json: bool,
    },
    /// Show CPU/memory usage (like kubectl top)
    Top {
        /// What to show: pods or nodes
        #[arg(default_value = "pods")]
        resource: String,
        /// Only show pods in this namespace
        #[arg(short, long)]
        namespace: Option<String>,
    },
    /// Known vulnerabilities of the running images, from the Trivy
    /// Operator's VulnerabilityReports: one row per image with its counts
    /// by severity, how many have a fix, and the workloads that use it.
    /// nauvi scans nothing itself; the data is as old as the last scan
    Vulns {
        /// Show this image's vulnerabilities and the package upgrades that
        /// fix them: a reference as listed (`nginx:1.27`) or a digest (at
        /// least 12 characters)
        image: Option<String>,
        /// Only this namespace (default: all namespaces you may read)
        #[arg(short, long)]
        namespace: Option<String>,
        /// All namespaces (the default; accepted for kubectl habits)
        #[arg(short = 'A', long, conflicts_with = "namespace")]
        all_namespaces: bool,
        /// Only images (and vulnerabilities) of this severity or worse
        #[arg(long, value_enum, value_name = "SEVERITY")]
        severity: Option<nauvi::image_security::Severity>,
        /// Only vulnerabilities that have a fixed version
        #[arg(long)]
        fixable: bool,
        /// Output format
        #[arg(short, long, value_enum, default_value_t = VulnsOutput::Table)]
        output: VulnsOutput,
    },
    /// Set the replica count of a Deployment, StatefulSet or ReplicaSet
    Scale {
        /// `<kind>/<name>`, e.g. `deploy/web`
        target: String,
        /// The new number of replicas
        #[arg(long)]
        replicas: i32,
        /// Namespace (default: `default`)
        #[arg(short, long)]
        namespace: Option<String>,
    },
    /// Restart the pods of a Deployment, StatefulSet or DaemonSet
    Restart {
        /// `<kind>/<name>`, e.g. `deploy/web`
        target: String,
        /// Namespace (default: `default`)
        #[arg(short, long)]
        namespace: Option<String>,
    },
    /// Mark a node unschedulable
    Cordon {
        /// The node's name
        node: String,
    },
    /// Mark a node schedulable again
    Uncordon {
        /// The node's name
        node: String,
    },
    /// Cordon a node and evict its pods (respects PodDisruptionBudgets)
    Drain {
        /// The node's name
        node: String,
        /// Give up after this many seconds
        #[arg(long, default_value_t = 300)]
        timeout: u64,
        /// Only evict pods matching this label selector
        #[arg(long)]
        pod_selector: Option<String>,
    },
    /// Create a Job from a CronJob now
    Trigger {
        /// `cronjob/<name>`
        target: String,
        /// Namespace (default: `default`)
        #[arg(short, long)]
        namespace: Option<String>,
    },
    /// Suspend a CronJob
    Suspend {
        /// `cronjob/<name>`
        target: String,
        /// Namespace (default: `default`)
        #[arg(short, long)]
        namespace: Option<String>,
    },
    /// Resume a suspended CronJob
    Resume {
        /// `cronjob/<name>`
        target: String,
        /// Namespace (default: `default`)
        #[arg(short, long)]
        namespace: Option<String>,
    },
    /// Evict a pod through the Eviction API (respects PodDisruptionBudgets)
    Evict {
        /// The pod's name, or `pod/<name>`
        pod: String,
        /// Namespace (default: `default`)
        #[arg(short, long)]
        namespace: Option<String>,
    },
    /// Delete an object of any kind
    Delete {
        /// `<kind>/<name>`
        target: String,
        /// Namespace (default: `default`)
        #[arg(short, long)]
        namespace: Option<String>,
        /// Grace period 0, for pods stuck terminating (pods only)
        #[arg(long)]
        force: bool,
    },
    /// Create or update objects from a YAML file (like kubectl apply -f)
    Apply {
        /// Manifest file, or `-` for stdin; may hold many documents
        #[arg(short, long)]
        file: String,
        /// Namespace for objects that have none (default: the context's)
        #[arg(short, long)]
        namespace: Option<String>,
        /// Validate on the server only; store nothing
        #[arg(long)]
        dry_run: bool,
    },
    /// Print an object of any kind as YAML (Secret values hidden)
    Yaml {
        /// `<kind>/<name>` (`deploy/web`), or a pod name
        target: String,
        /// Namespace (default: the context's namespace)
        #[arg(short, long)]
        namespace: Option<String>,
        /// Show Secret values instead of a placeholder
        #[arg(long)]
        reveal: bool,
    },
    /// Forward ports of a pod, Service or workload to localhost (until Ctrl-C).
    /// A Service or workload forward picks a ready pod for each connection,
    /// so it keeps working when pods restart.
    #[command(name = "port-forward")]
    PortForward {
        /// A pod name, `pod/<name>`, `svc/<name>`, or `deploy/`, `sts/`, `rs/`,
        /// `ds/<name>`
        target: String,
        /// `<remote>`, `<local>:<remote>` or `:<remote>` (random local port).
        /// The remote port may be a port name. With only `<remote>` the local
        /// port is the same if it is free and at least 1024, otherwise random.
        #[arg(required = true, value_name = "PORT")]
        ports: Vec<String>,
        /// Namespace (default: the context's namespace)
        #[arg(short, long)]
        namespace: Option<String>,
    },
    /// Run a command in a pod (non-interactive)
    ///
    /// Exits with the command's exit code, like `kubectl exec`: 0 when it
    /// succeeds, its own code when it exits non-zero, and 1 when it cannot be
    /// run (no such pod, container or executable).
    Exec {
        /// Pod name
        name: String,
        /// Pod namespace
        #[arg(short, long)]
        namespace: Option<String>,
        /// Container name (defaults to the pod's only container)
        #[arg(short, long)]
        container: Option<String>,
        /// Command to run (after --)
        #[arg(last = true, required = true)]
        command: Vec<String>,
    },
    /// Attach to the main process of a pod's container (its stdin and
    /// output), like `kubectl attach -it`. The container must have been
    /// started with `stdin: true`; detaching (Ctrl-C without a TTY, or
    /// closing the terminal) leaves the process running.
    Attach {
        /// Pod name
        pod: String,
        /// Pod namespace (default: `default`)
        #[arg(short, long)]
        namespace: Option<String>,
        /// Container (default: the pod's default container, else its first)
        #[arg(short, long)]
        container: Option<String>,
    },
    /// Open a shell in a pod through an ephemeral debug container that shares
    /// a container's processes. Works on images without a shell; the
    /// container cannot be removed and stays until the pod is deleted.
    Debug {
        /// Pod name
        pod: String,
        /// Pod namespace (default: `default`)
        #[arg(short, long)]
        namespace: Option<String>,
        /// Container whose processes the debug container sees (default: the
        /// pod's first container)
        #[arg(short, long)]
        container: Option<String>,
        /// Image of the debug container, e.g. `nicolaka/netshoot` for
        /// network tools
        #[arg(long, default_value = nauvi::debug::DEFAULT_DEBUG_IMAGE)]
        image: String,
    },
    /// Open a root shell on a node through a privileged pod (deleted when the
    /// shell exits)
    #[command(name = "node-shell")]
    NodeShell {
        /// The node's name
        node: String,
        /// Namespace of the privileged pod; it must allow privileged pods
        #[arg(short, long, default_value = nauvi::node_shell::NODE_SHELL_NAMESPACE)]
        namespace: String,
        /// Image of the pod; it needs `nsenter`
        #[arg(long, default_value = nauvi::node_shell::NODE_SHELL_IMAGE)]
        image: String,
    },
    /// Helm releases, read from the cluster (no helm binary needed)
    Helm {
        #[command(subcommand)]
        command: HelmCommand,
    },
    /// Print a shell completion script, e.g.
    /// `nauvi completions bash > ~/.local/share/bash-completion/completions/nauvi`
    Completions {
        #[arg(value_enum)]
        shell: Shell,
    },
}

/// `-o` of `nauvi vulns`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, clap::ValueEnum)]
pub enum VulnsOutput {
    /// Aligned columns
    Table,
    /// The whole result as JSON (stable field names)
    Json,
}

#[derive(Subcommand, Debug)]
pub enum HelmCommand {
    /// List releases with their chart, revision and status
    #[command(alias = "ls")]
    List {
        /// Only this namespace (default: all namespaces)
        #[arg(short, long)]
        namespace: Option<String>,
    },
    /// Show one release: its status, values, manifest, notes or history
    Get {
        /// The release's name
        release: String,
        #[arg(value_enum, default_value_t = HelmSection::All)]
        section: HelmSection,
        /// Namespace (default: the context's namespace)
        #[arg(short, long)]
        namespace: Option<String>,
        /// Revision to show (default: the newest)
        #[arg(long)]
        revision: Option<u32>,
        /// Values: include the chart defaults
        #[arg(long)]
        all: bool,
        /// Manifest: show Secret values instead of a placeholder
        #[arg(long)]
        reveal: bool,
    },
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::CommandFactory;

    fn parse(args: &[&str]) -> Cli {
        Cli::try_parse_from(std::iter::once("nauvi").chain(args.iter().copied()))
            .unwrap_or_else(|e| panic!("{args:?}: {e}"))
    }

    #[test]
    fn definition_is_valid() {
        Cli::command().debug_assert();
    }

    #[test]
    fn problems_takes_a_namespace_kinds_and_a_limit() {
        match parse(&[
            "problems",
            "-n",
            "demo",
            "-k",
            "pods,jobs",
            "--kind",
            "nodes",
        ])
        .command
        {
            Commands::Problems {
                namespace,
                kinds,
                limit,
                ..
            } => {
                assert_eq!(namespace.as_deref(), Some("demo"));
                assert_eq!(kinds, ["pods", "jobs", "nodes"]);
                assert_eq!(limit, nauvi::problems::DEFAULT_PROBLEMS);
            }
            other => panic!("{other:?}"),
        }
        match parse(&["problems", "-A", "--limit", "7"]).command {
            Commands::Problems {
                namespace, limit, ..
            } => {
                assert_eq!(namespace, None);
                assert_eq!(limit, 7);
            }
            other => panic!("{other:?}"),
        }
        assert!(Cli::try_parse_from(["nauvi", "problems", "-A", "-n", "x"]).is_err());
    }

    #[test]
    fn vulns_takes_an_image_a_severity_and_json() {
        use nauvi::image_security::Severity;
        match parse(&[
            "vulns",
            "nginx:1.27",
            "-n",
            "shop",
            "--severity",
            "high",
            "--fixable",
            "-o",
            "json",
        ])
        .command
        {
            Commands::Vulns {
                image,
                namespace,
                severity,
                fixable,
                output,
                ..
            } => {
                assert_eq!(image.as_deref(), Some("nginx:1.27"));
                assert_eq!(namespace.as_deref(), Some("shop"));
                assert_eq!(severity, Some(Severity::High));
                assert!(fixable);
                assert_eq!(output, VulnsOutput::Json);
            }
            other => panic!("{other:?}"),
        }
        match parse(&["vulns", "-A"]).command {
            Commands::Vulns {
                image,
                severity,
                output,
                ..
            } => {
                assert_eq!((image, severity), (None, None));
                assert_eq!(output, VulnsOutput::Table);
            }
            other => panic!("{other:?}"),
        }
        assert!(Cli::try_parse_from(["nauvi", "vulns", "--severity", "bad"]).is_err());
    }

    #[test]
    fn global_flags_work_before_and_after_the_subcommand() {
        let cli = parse(&["--context", "a", "nodes"]);
        assert_eq!(cli.context.as_deref(), Some("a"));
        let cli = parse(&["pods", "--context", "b", "--kubeconfig", "/tmp/kc"]);
        assert_eq!(cli.context.as_deref(), Some("b"));
        assert_eq!(cli.kubeconfig, Some(PathBuf::from("/tmp/kc")));
    }

    #[test]
    fn get_flags() {
        let cli = parse(&[
            "get",
            "pods",
            "-n",
            "demo",
            "-o",
            "name",
            "-l",
            "app=web",
            "--field-selector",
            "status.phase=Running",
        ]);
        let Commands::Get {
            kind,
            name,
            namespace,
            output,
            selector,
            field_selector,
            reveal,
            all_namespaces,
        } = cli.command
        else {
            panic!("not get");
        };
        assert_eq!(kind, "pods");
        assert_eq!(name, None);
        assert_eq!(namespace.as_deref(), Some("demo"));
        assert_eq!(output, OutputFormat::Name);
        assert_eq!(selector.as_deref(), Some("app=web"));
        assert_eq!(field_selector.as_deref(), Some("status.phase=Running"));
        assert!(!reveal && !all_namespaces);
        assert!(Cli::try_parse_from(["nauvi", "get", "pods", "-A", "-n", "x"]).is_err());
        let Commands::Get { output, name, .. } =
            parse(&["get", "deploy", "web", "-o", "yaml"]).command
        else {
            panic!("not get");
        };
        assert_eq!(output, OutputFormat::Yaml);
        assert_eq!(name.as_deref(), Some("web"));
    }

    #[test]
    fn apply_takes_the_global_flags() {
        let cli = parse(&["apply", "-f", "-", "--dry-run", "--context", "c"]);
        assert_eq!(cli.context.as_deref(), Some("c"));
        let Commands::Apply { file, dry_run, .. } = cli.command else {
            panic!("not apply");
        };
        assert_eq!(file, "-");
        assert!(dry_run);
    }

    #[test]
    fn port_forward_forms() {
        // The old `<pod> <port>` form still parses.
        let Commands::PortForward { target, ports, .. } =
            parse(&["port-forward", "web-1", "80"]).command
        else {
            panic!("not port-forward");
        };
        assert_eq!((target.as_str(), ports), ("web-1", vec!["80".to_string()]));
        let Commands::PortForward {
            target,
            ports,
            namespace,
        } = parse(&["port-forward", "svc/api", "8080:80", ":http", "-n", "demo"]).command
        else {
            panic!("not port-forward");
        };
        assert_eq!(target, "svc/api");
        assert_eq!(ports, vec!["8080:80", ":http"]);
        assert_eq!(namespace.as_deref(), Some("demo"));
        assert!(Cli::try_parse_from(["nauvi", "port-forward", "svc/api"]).is_err());
    }

    #[test]
    fn attach() {
        let Commands::Attach {
            pod,
            namespace,
            container,
        } = parse(&["attach", "repl", "-n", "demo", "-c", "app"]).command
        else {
            panic!("not attach");
        };
        assert_eq!(pod, "repl");
        assert_eq!(namespace.as_deref(), Some("demo"));
        assert_eq!(container.as_deref(), Some("app"));
        let Commands::Attach { container, .. } = parse(&["attach", "repl"]).command else {
            panic!("not attach");
        };
        assert_eq!(container, None);
    }

    #[test]
    fn debug_and_node_shell() {
        let Commands::Debug {
            pod,
            namespace,
            container,
            image,
        } = parse(&["debug", "web-1", "-n", "demo", "-c", "app"]).command
        else {
            panic!("not debug");
        };
        assert_eq!((pod.as_str(), image.as_str()), ("web-1", "busybox:1.37"));
        assert_eq!(namespace.as_deref(), Some("demo"));
        assert_eq!(container.as_deref(), Some("app"));
        let Commands::Debug { image, .. } =
            parse(&["debug", "p", "--image", "nicolaka/netshoot"]).command
        else {
            panic!("not debug");
        };
        assert_eq!(image, "nicolaka/netshoot");
        let Commands::NodeShell {
            node,
            namespace,
            image,
        } = parse(&["node-shell", "worker"]).command
        else {
            panic!("not node-shell");
        };
        assert_eq!(
            (node.as_str(), namespace.as_str(), image.as_str()),
            ("worker", "kube-system", nauvi::node_shell::NODE_SHELL_IMAGE)
        );
    }

    #[test]
    fn rejects_unknown_output_format() {
        assert!(Cli::try_parse_from(["nauvi", "get", "pods", "-o", "xml"]).is_err());
    }

    #[test]
    fn yaml_describe_top_and_completions() {
        let Commands::Yaml { target, reveal, .. } =
            parse(&["yaml", "secret/creds", "--reveal"]).command
        else {
            panic!("not yaml");
        };
        assert_eq!(target, "secret/creds");
        assert!(reveal);
        let Commands::Describe { target, name, .. } =
            parse(&["describe", "pod", "hungry", "-n", "default"]).command
        else {
            panic!("not describe");
        };
        assert_eq!((target.as_str(), name.as_deref()), ("pod", Some("hungry")));
        let Commands::Top {
            resource,
            namespace,
        } = parse(&["top", "pods", "-n", "demo"]).command
        else {
            panic!("not top");
        };
        assert_eq!(
            (resource.as_str(), namespace.as_deref()),
            ("pods", Some("demo"))
        );
        let Commands::Helm {
            command:
                HelmCommand::Get {
                    release,
                    section,
                    revision,
                    ..
                },
        } = parse(&["helm", "get", "web", "manifest", "--revision", "2"]).command
        else {
            panic!("not helm get");
        };
        assert_eq!(
            (release.as_str(), section, revision),
            ("web", HelmSection::Manifest, Some(2))
        );
        assert!(matches!(
            parse(&["helm", "ls", "-n", "x"]).command,
            Commands::Helm {
                command: HelmCommand::List { .. }
            }
        ));
        assert!(matches!(
            parse(&["completions", "zsh"]).command,
            Commands::Completions { shell: Shell::Zsh }
        ));
    }
}
