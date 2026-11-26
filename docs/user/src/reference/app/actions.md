# Actions

Actions run from the row menu (**⋮**, a right-click or `Shift+F10`), the
detail panel's header, the command palette (`>`), or on several selected rows
from the selection bar. The row menu lists **Logs**, **Shell** and **Edit
YAML** first, and shows each action's key.

| Action | On | What it does |
| --- | --- | --- |
| Scale | Deployments, StatefulSets, ReplicaSets | Set the replica count |
| Restart | Deployments, StatefulSets, DaemonSets | Rollout restart (`Shift+R` on the row). It always asks first, from the menu, the panel or the key |
| Cordon / Uncordon | Nodes | Mark the node unschedulable / schedulable |
| Drain | Nodes | Cordon, then evict its pods, with progress, respecting PodDisruptionBudgets |
| Evict | Pods | Evict through the Eviction API, as a drain does |
| Trigger | CronJobs | Create a Job now |
| Suspend / Resume | CronJobs | Stop or restart the schedule |
| Delete | Anything | Delete; **Force delete** on pods uses grace period 0 |

- **Destructive actions ask** for confirmation and list the exact objects.
  The confirm dialog shows the cluster's colour.
- **Evict**: if a PodDisruptionBudget would be violated, the eviction is
  refused and the dialog says why. It needs `create pods/eviction`.
- **Not allowed?** Actions you aren't allowed to run (per RBAC) are greyed
  out in the row menu, the detail panel, the selection bar and the command
  palette, and the keyboard `Delete` refuses them. The tooltip names the
  missing permission, for example *Not allowed: you can't delete pods in
  namespace demo*.
- On a [protected cluster](modes.md) every action asks you to type the
  context's name; on a read-only one actions are refused.

The CLI has the same actions: [CLI actions](../cli/actions.md).
