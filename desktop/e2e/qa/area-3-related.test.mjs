// Area 3 of #83, PR #64 (related objects and per-kind summaries) and PR #87
// (Access Control detail sections):
// - open a Deployment, Service, Ingress, Node, PVC, ConfigMap, Secret,
//   CronJob and HPA and click a related row: the linked object opens
// - scale a Deployment: its panel's Pods group and the Pods table follow
// - the panel at its default 420 px: wide related tables scroll inside the
//   panel, the page does not scroll sideways
// - Role -> RoleBinding -> ServiceAccount -> back, ClusterRole and its
//   bindings, a PDB with its pods
// - "View instances" on a CRD with two served versions
// - following a link out of a filtered table clears a filter that would hide
//   the opened object: its row is listed and selected (#108)
// Everything lives in a temp namespace, plus a uniquely named ClusterRole,
// ClusterRoleBinding and CRD, deleted afterwards.

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { By } from "selenium-webdriver";
import { kubectl, deleteNamespace, podNames, tempNamespace } from "../lib/cluster.mjs";
import {
  kindSummary,
  openClusterDetail,
  openRelated,
  panelTitle,
  relatedGroups,
  waitPanelTitle,
  waitRelatedGroup,
} from "../lib/panels.mjs";
import { appSession, waitLive } from "../lib/qa.mjs";
import { resizeWindow } from "../lib/window.mjs";

const T = { timeout: 180_000 };
const suffix = `${Date.now().toString(36)}${process.pid.toString(36)}`;
const CLUSTER_ROLE = `qa-area3-cr-${suffix}`;
const CRD_PLURAL = `qaarea3${suffix}s`;
const CRD_GROUP = "qa.nauvi.dev";
const CRD = `${CRD_PLURAL}.${CRD_GROUP}`;
const CRD_KIND = `QaArea3${suffix.replace(/^[0-9]+/, "")}`.replace(/[^A-Za-z0-9]/g, "");

const web = (name, extra = "") => `
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${name}
spec:
  replicas: 2
  selector:
    matchLabels: { app: ${name} }
  template:
    metadata:
      labels: { app: ${name} }
    spec:
      serviceAccountName: qa-sa
      terminationGracePeriodSeconds: 0
      containers:
        - name: web
          image: busybox:1.36
          imagePullPolicy: IfNotPresent
          command: ["sh", "-c", "mkdir -p /www && echo ok > /www/index.html && exec httpd -f -p 8080 -h /www"]
          ports: [{ containerPort: 8080 }]
          resources:
            requests: { cpu: 10m, memory: 16Mi }
            limits: { memory: 32Mi }
${extra}`;

const nsFixtures = (ns) => `
apiVersion: v1
kind: ServiceAccount
metadata: { name: qa-sa }
---
apiVersion: v1
kind: ConfigMap
metadata: { name: qa-cm }
data: { greeting: hello }
---
apiVersion: v1
kind: Secret
metadata: { name: qa-sec }
stringData: { token: qa-area3-secret }
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata: { name: qa-pvc }
spec:
  accessModes: [ReadWriteOnce]
  resources: { requests: { storage: 16Mi } }
---
${web(
  "qa-app",
  `          volumeMounts:
            - { name: cm, mountPath: /etc/cm }
            - { name: sec, mountPath: /etc/sec }
            - { name: data, mountPath: /data }
      volumes:
        - { name: cm, configMap: { name: qa-cm } }
        - { name: sec, secret: { secretName: qa-sec } }
        - { name: data, persistentVolumeClaim: { claimName: qa-pvc } }`,
)}
---
${web("qa-scale").replace("replicas: 2", "replicas: 1")}
---
apiVersion: v1
kind: Service
metadata: { name: qa-svc }
spec:
  selector: { app: qa-app }
  ports: [{ port: 80, targetPort: 8080 }]
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata: { name: qa-ing }
spec:
  rules:
    - host: qa-area3.example
      http:
        paths:
          - path: /
            pathType: Prefix
            backend: { service: { name: qa-svc, port: { number: 80 } } }
---
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata: { name: qa-hpa }
spec:
  scaleTargetRef: { apiVersion: apps/v1, kind: Deployment, name: qa-app }
  minReplicas: 2
  maxReplicas: 2
  metrics:
    - type: Resource
      resource: { name: cpu, target: { type: Utilization, averageUtilization: 80 } }
---
apiVersion: batch/v1
kind: CronJob
metadata: { name: qa-cron }
spec:
  schedule: "0 0 1 1 *"
  suspend: true
  jobTemplate:
    spec:
      template:
        spec:
          restartPolicy: Never
          containers:
            - name: once
              image: busybox:1.36
              imagePullPolicy: IfNotPresent
              command: ["true"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata: { name: qa-role }
rules:
  - apiGroups: [""]
    resources: [configmaps]
    verbs: [get, list]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata: { name: qa-rb }
roleRef: { apiGroup: rbac.authorization.k8s.io, kind: Role, name: qa-role }
subjects:
  - { kind: ServiceAccount, name: qa-sa, namespace: ${ns} }
  - { kind: User, name: qa-area3-user, apiGroup: rbac.authorization.k8s.io }
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata: { name: qa-rb-cluster-role }
roleRef: { apiGroup: rbac.authorization.k8s.io, kind: ClusterRole, name: ${CLUSTER_ROLE} }
subjects:
  - { kind: ServiceAccount, name: qa-sa, namespace: ${ns} }
---
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata: { name: qa-pdb }
spec:
  minAvailable: 1
  selector:
    matchLabels: { app: qa-app }
`;

const clusterFixtures = (ns) => `
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata: { name: ${CLUSTER_ROLE} }
rules:
  - apiGroups: [""]
    resources: [pods]
    verbs: [get, list]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata: { name: ${CLUSTER_ROLE} }
roleRef: { apiGroup: rbac.authorization.k8s.io, kind: ClusterRole, name: ${CLUSTER_ROLE} }
subjects:
  - { kind: ServiceAccount, name: qa-sa, namespace: ${ns} }
---
apiVersion: apiextensions.k8s.io/v1
kind: CustomResourceDefinition
metadata: { name: ${CRD} }
spec:
  group: ${CRD_GROUP}
  scope: Namespaced
  names: { plural: ${CRD_PLURAL}, singular: ${CRD_PLURAL.slice(0, -1)}, kind: ${CRD_KIND} }
  versions:
    - name: v1
      served: true
      storage: true
      schema: { openAPIV3Schema: { type: object, x-kubernetes-preserve-unknown-fields: true } }
      additionalPrinterColumns:
        - { name: Colour, type: string, jsonPath: .spec.colour }
    - name: v1beta1
      served: true
      storage: false
      schema: { openAPIV3Schema: { type: object, x-kubernetes-preserve-unknown-fields: true } }
`;

/** Click the first link of a related group and wait for that object's panel. */
async function followFirst(app, group, expectTitle) {
  const g = await waitRelatedGroup(app, group);
  assert.ok(g.links.length > 0, `"${group}" has links: ${JSON.stringify(g)}`);
  const name = g.links[0];
  await openRelated(app, group, name);
  await waitPanelTitle(app, expectTitle ? expectTitle(name) : name);
  return name;
}

/** The opened object's row is in the table, selected, under an empty filter (#108). */
async function assertOpenedRow(app, ns, name) {
  const filter = await app.js(`return document.querySelector('input[aria-label="Filter"]').value`);
  assert.equal(filter, "", "the filter of the previous kind is cleared");
  await app.waitFor(
    () =>
      app.js(
        `return Array.from(document.querySelectorAll('[data-testid="resource-row"].selected'), (r) =>
           Array.from(r.querySelectorAll('[role="gridcell"]'), (c) => c.textContent.trim()))
           .some((cells) => cells[1] === arguments[0] && cells[2] === arguments[1])`,
        name,
        ns,
      ),
    { message: `the selected row ${ns}/${name} in the table` },
  );
}

async function logPanel(app, what) {
  const groups = await relatedGroups(app);
  const summary = await kindSummary(app);
  console.log(
    `${what}: summary=${JSON.stringify(summary)} groups=${JSON.stringify(
      groups.map((g) => ({ title: g.title, count: g.count, error: g.error, rows: g.rows.length, links: g.links })),
    )}`,
  );
  return groups;
}

function titles(groups) {
  return groups.map((g) => g.title);
}

describe("area 3: related objects and Access Control sections (#64, #87)", { timeout: 25 * 60_000 }, () => {
  let ns;
  before(() => {
    ns = tempNamespace("qa-area3-rel");
    kubectl(["apply", "-f", "-"], clusterFixtures(ns));
    kubectl(["wait", "--for=condition=Established", `crd/${CRD}`, "--timeout=60s"]);
    kubectl(["-n", ns, "apply", "-f", "-"], nsFixtures(ns));
    kubectl(
      ["-n", ns, "apply", "-f", "-"],
      `apiVersion: ${CRD_GROUP}/v1\nkind: ${CRD_KIND}\nmetadata: { name: qa-instance }\nspec: { colour: teal }\n`,
    );
    kubectl(["-n", ns, "create", "job", "--from=cronjob/qa-cron", "qa-cron-manual"]);
    kubectl(["-n", ns, "rollout", "status", "deploy/qa-app", "--timeout=180s"]);
    kubectl(["-n", ns, "rollout", "status", "deploy/qa-scale", "--timeout=180s"]);
  });
  after(() => {
    deleteNamespace(ns);
    for (const obj of [`clusterrolebinding/${CLUSTER_ROLE}`, `clusterrole/${CLUSTER_ROLE}`, `crd/${CRD}`]) {
      try {
        kubectl(["delete", obj, "--wait=false", "--ignore-not-found"]);
      } catch (e) {
        console.error(`could not delete ${obj}: ${e.message}`);
      }
    }
  });

  const s = appSession("area-3-related");

  it("Deployment: summary, ReplicaSets and Pods; a pod row opens the pod", T, async () => {
    const { app } = s;
    await resizeWindow(app, 1280, 800);
    await waitLive(app);
    await app.openDetail("Deployments", ns, "qa-app");
    await waitRelatedGroup(app, "Pods");
    const groups = await logPanel(app, "Deployment");
    for (const t of ["ReplicaSets", "Pods"]) assert.ok(titles(groups).includes(t), `group ${t}`);
    assert.equal(groups.find((g) => g.title === "Pods").rows.length, 2);
    assert.ok((await kindSummary(app)).line, "a summary line");
    await followFirst(app, "Pods", (n) => `${ns}/${n}`);
    // The pod's reverse relations.
    await waitRelatedGroup(app, "ConfigMaps");
    await logPanel(app, "Pod of the Deployment");
  });

  it("scaling a Deployment: its Pods group and the Pods table follow", T, async () => {
    const { app } = s;
    await app.openDetail("Deployments", ns, "qa-scale");
    await app.waitFor(async () => (await waitRelatedGroup(app, "Pods")).rows.length === 1, { message: "1 pod" });
    kubectl(["-n", ns, "scale", "deploy/qa-scale", "--replicas=3"]);
    await app.waitFor(async () => (await waitRelatedGroup(app, "Pods")).rows.length === 3, {
      timeout: 90_000,
      message: "3 pods in the Pods group",
    });
    await logPanel(app, "scaled Deployment");
    await app.nav("Pods");
    await app.filter("qa-scale");
    await app.waitFor(async () => (await app.rows()).filter(([, n]) => n === ns).length === 3, {
      timeout: 60_000,
      message: "3 qa-scale rows in the Pods table",
    });
  });

  it("Service: pods, EndpointSlices and its Ingress; the Ingress row opens it", T, async () => {
    const { app } = s;
    await app.openDetail("Services", ns, "qa-svc");
    await waitRelatedGroup(app, "Pods");
    const groups = await logPanel(app, "Service");
    for (const t of ["Pods", "EndpointSlices", "Ingresses"]) assert.ok(titles(groups).includes(t), `group ${t}`);
    await followFirst(app, "Ingresses", (n) => `Ingress ${ns}/${n}`);
  });

  it("Ingress: its rules link the Service; the link opens it", T, async () => {
    const { app } = s;
    await app.openDetail("Ingresses", ns, "qa-ing");
    const g = await waitRelatedGroup(app, "Rules");
    await logPanel(app, "Ingress");
    assert.deepEqual(g.rows[0], ["qa-area3.example", "/", "qa-svc", "80"]);
    const svc = await followFirst(app, "Rules", (n) => `Service ${ns}/${n}`);
    await assertOpenedRow(app, ns, svc);
  });

  it("PVC, ConfigMap and Secret: used by the Deployment's pods", T, async () => {
    const { app } = s;
    for (const [label, name] of [
      ["Persistent Volume Claims", "qa-pvc"],
      ["Config Maps", "qa-cm"],
      ["Secrets", "qa-sec"],
    ]) {
      await app.openDetail(label, ns, name);
      const g = await waitRelatedGroup(app, "Used by pods");
      await logPanel(app, label);
      assert.equal(g.rows.length, 2, `${name} used by 2 pods`);
    }
    await followFirst(app, "Used by pods", (n) => `${ns}/${n}`);
  });

  it("CronJob: its Job; the row opens the Job", T, async () => {
    const { app } = s;
    await app.openDetail("CronJobs", ns, "qa-cron");
    await waitRelatedGroup(app, "Jobs");
    await logPanel(app, "CronJob");
    await followFirst(app, "Jobs", (n) => `Job ${ns}/${n}`);
  });

  it("HPA: its target and summary", T, async () => {
    const { app } = s;
    await app.openDetail("HPAs", ns, "qa-hpa");
    await app.waitFor(async () => (await relatedGroups(app)).length > 0 || (await kindSummary(app)).line, {
      message: "HPA sections",
    });
    const groups = await logPanel(app, "HPA");
    const target = groups.find((g) => g.links.includes("qa-app"));
    assert.ok(target, `a group linking qa-app: ${JSON.stringify(groups)}`);
    await openRelated(app, target.title, "qa-app");
    await waitPanelTitle(app, `Deployment ${ns}/qa-app`);
    await assertOpenedRow(app, ns, "qa-app");
  });

  it("Node: its pods and allocated resources; wide tables scroll inside the 420 px panel", T, async () => {
    const { app } = s;
    const node = kubectl(["-n", ns, "get", "pod", podNames(ns, "app=qa-app")[0], "-o", "jsonpath={.spec.nodeName}"]);
    await openClusterDetail(app, "Nodes", node);
    const g = await waitRelatedGroup(app, "Pods");
    await logPanel(app, "Node");
    assert.ok(g.rows.length > 0);
    const layout = await app.js(`
      const p = document.querySelector('[data-testid="detail-panel"]');
      const scrollers = Array.from(p.querySelectorAll('.scroll-x'), (s) => ({ sw: s.scrollWidth, cw: s.clientWidth }));
      return { panel: p.getBoundingClientRect().width, page: document.documentElement.scrollWidth,
               view: window.innerWidth, scrollers };`);
    console.log(`node panel layout: ${JSON.stringify(layout)}`);
    assert.ok(Math.abs(layout.panel - 420) <= 2, `panel width ${layout.panel}`);
    assert.ok(layout.page <= layout.view, "no sideways page scroll");
    assert.ok(layout.scrollers.every((x) => x.cw <= layout.panel), "tables stay inside the panel");
    await app.js(`document.querySelector('[data-testid="detail-panel"] [data-testid="related-group"][aria-label="Pods"]')?.scrollIntoView()`);
  });

  it("Role -> RoleBinding -> ServiceAccount -> back to the Role", T, async () => {
    const { app } = s;
    await app.openDetail("Roles", ns, "qa-role");
    await waitRelatedGroup(app, "Role bindings");
    await logPanel(app, "Role");
    await followFirst(app, "Role bindings", (n) => `RoleBinding ${ns}/${n}`);
    await app.waitFor(async () => (await relatedGroups(app)).some((g) => g.links.includes("qa-sa")), {
      message: "the RoleBinding's subjects",
    });
    const groups = await logPanel(app, "RoleBinding");
    const sa = groups.find((g) => g.links.includes("qa-sa"));
    assert.ok(sa, "a group linking qa-sa");
    assert.ok(groups.some((g) => g.rows.some((r) => r.includes("qa-area3-user"))), "the User subject is listed");
    await openRelated(app, sa.title, "qa-sa");
    await waitPanelTitle(app, `ServiceAccount ${ns}/qa-sa`);
    await waitRelatedGroup(app, "Cluster role bindings");
    const saGroups = await logPanel(app, "ServiceAccount");
    for (const t of ["Role bindings", "Cluster role bindings"]) assert.ok(titles(saGroups).includes(t), `group ${t}`);
    assert.ok(
      saGroups.find((g) => g.title === "Cluster role bindings").links.includes(CLUSTER_ROLE),
      "the ClusterRoleBinding",
    );
    await openRelated(app, "Role bindings", "qa-rb");
    await waitPanelTitle(app, `RoleBinding ${ns}/qa-rb`);
    const back = await app.waitFor(
      async () => (await relatedGroups(app)).find((g) => g.links.includes("qa-role")),
      { message: "the RoleBinding's Role" },
    );
    await openRelated(app, back.title, "qa-role");
    await waitPanelTitle(app, `Role ${ns}/qa-role`);
  });

  it("ClusterRole: its ClusterRoleBinding and cross-namespace RoleBindings", T, async () => {
    const { app } = s;
    await openClusterDetail(app, "Cluster Roles", CLUSTER_ROLE);
    await waitRelatedGroup(app, "Cluster role bindings");
    const groups = await logPanel(app, "ClusterRole");
    assert.ok(groups.find((g) => g.title === "Cluster role bindings").links.includes(CLUSTER_ROLE));
    const rb = groups.find((g) => g.title === "Role bindings");
    assert.ok(rb && rb.rows.some((r) => r.includes("qa-rb-cluster-role")), "the RoleBinding in the temp namespace");
    await openRelated(app, "Cluster role bindings", CLUSTER_ROLE);
    await waitPanelTitle(app, `ClusterRoleBinding ${CLUSTER_ROLE}`);
  });

  it("PDB: status and its pods", T, async () => {
    const { app } = s;
    await app.openDetail("Pod Disruption Budgets", ns, "qa-pdb");
    const g = await waitRelatedGroup(app, "Pods");
    await logPanel(app, "PDB");
    assert.equal(g.rows.length, 2);
    assert.ok((await kindSummary(app)).line, "a PDB summary");
  });

  it("Definitions: View instances on a CRD with two served versions", T, async () => {
    const { app } = s;
    await openClusterDetail(app, "Definitions", CRD);
    await logPanel(app, "CRD");
    const btn = await app.find(By.xpath("//*[@data-testid='detail-panel']//button[normalize-space()='View instances']"));
    await btn.click();
    await app.filter("qa-instance");
    await app.waitFor(async () => (await app.rows()).some(([n, nsCell]) => n === "qa-instance" && nsCell === ns), {
      timeout: 30_000,
      message: "the CRD instance row",
    });
    const header = await app.js(
      `return Array.from(document.querySelectorAll('[data-testid="resource-table"] [role="columnheader"]'), (h) => h.textContent.trim())`,
    );
    console.log(`instances table: ${JSON.stringify(header)} rows=${JSON.stringify(await app.rows())}`);
    assert.ok(header.some((h) => /Colour/i.test(h)), "the printer column");
    await (await app.find(app.row("qa-instance", ns))).click();
    await waitPanelTitle(app, `${ns}/qa-instance`);
    console.log(`instance panel: ${await panelTitle(app)}`);
  });
});
