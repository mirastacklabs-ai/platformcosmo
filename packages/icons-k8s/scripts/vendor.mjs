// Dev-time vendoring script (not part of the build). Control-plane "labeled" icons are omitted: their only difference is a text label, which the sanitizer strips.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { sanitizeSvg } from "../../core/src/icons/sanitize.ts";

const up = process.argv[2]; // kubernetes/community checkout (icons/ inside)
const out = process.argv[3]; // packages/icons-k8s
const sha = process.argv[4];

// [upstream path under icons/svg, id, aliases, category, tags]
const list = [
  ["resources/unlabeled/c-role", "cluster-role", ["c-role", "clusterrole"], "security", ["rbac"]],
  ["resources/unlabeled/cm", "configmap", ["cm", "config-map"], "general", ["config"]],
  [
    "resources/unlabeled/crb",
    "cluster-role-binding",
    ["crb", "clusterrolebinding"],
    "security",
    ["rbac"],
  ],
  ["resources/unlabeled/crd", "custom-resource-definition", ["crd"], "general", ["extension"]],
  ["resources/unlabeled/cronjob", "cronjob", ["cron-job"], "compute", ["schedule", "batch"]],
  ["resources/unlabeled/deploy", "deployment", ["deploy"], "compute", ["workload"]],
  ["resources/unlabeled/ds", "daemonset", ["ds", "daemon-set"], "compute", ["workload"]],
  ["resources/unlabeled/ep", "endpoints", ["ep", "endpoint"], "network", ["service"]],
  ["resources/unlabeled/group", "group", [], "security", ["rbac"]],
  [
    "resources/unlabeled/hpa",
    "horizontal-pod-autoscaler",
    ["hpa", "autoscaler"],
    "compute",
    ["scaling"],
  ],
  ["resources/unlabeled/ing", "ingress", ["ing"], "network", ["traffic", "http"]],
  ["resources/unlabeled/job", "job", [], "compute", ["batch"]],
  ["resources/unlabeled/limits", "limit-range", ["limits", "limitrange"], "general", ["quota"]],
  [
    "resources/unlabeled/netpol",
    "network-policy",
    ["netpol", "networkpolicy"],
    "network",
    ["firewall"],
  ],
  ["resources/unlabeled/ns", "namespace", ["ns"], "general", ["isolation"]],
  ["resources/unlabeled/pod", "pod", [], "compute", ["workload"]],
  ["resources/unlabeled/psp", "pod-security-policy", ["psp"], "security", ["policy"]],
  ["resources/unlabeled/pv", "persistent-volume", ["pv"], "data", ["storage"]],
  ["resources/unlabeled/pvc", "persistent-volume-claim", ["pvc"], "data", ["storage"]],
  ["resources/unlabeled/quota", "resource-quota", ["quota"], "general", ["limits"]],
  ["resources/unlabeled/rb", "role-binding", ["rb", "rolebinding"], "security", ["rbac"]],
  ["resources/unlabeled/role", "role", [], "security", ["rbac"]],
  ["resources/unlabeled/rs", "replicaset", ["rs", "replica-set"], "compute", ["workload"]],
  ["resources/unlabeled/sa", "service-account", ["sa", "serviceaccount"], "security", ["identity"]],
  ["resources/unlabeled/sc", "storage-class", ["sc", "storageclass"], "data", ["storage"]],
  ["resources/unlabeled/secret", "secret", [], "security", ["credentials"]],
  ["resources/unlabeled/sts", "statefulset", ["sts", "stateful-set"], "compute", ["workload"]],
  ["resources/unlabeled/svc", "service", ["svc"], "network", ["service-discovery"]],
  ["resources/unlabeled/user", "user", [], "security", ["identity"]],
  ["resources/unlabeled/vol", "volume", ["vol"], "data", ["storage"]],
  ["resources/unlabeled/vpa", "vertical-pod-autoscaler", ["vpa"], "compute", ["scaling"]],
  ["infrastructure_components/unlabeled/ca", "certificate-authority", ["ca"], "security", ["tls"]],
  [
    "infrastructure_components/unlabeled/control-plane",
    "control-plane",
    ["master"],
    "compute",
    ["cluster"],
  ],
  ["infrastructure_components/unlabeled/etcd", "etcd", [], "data", ["cluster"]],
  ["infrastructure_components/unlabeled/node", "node", ["worker-node"], "compute", ["cluster"]],
];

const round = (s) => s.replace(/-?\d*\.\d{4,}/g, (m) => String(Number(Number(m).toFixed(3))));

mkdirSync(`${out}/svg`, { recursive: true });
const icons = [];
for (const [path, id, aliases, category, tags] of list) {
  const raw = readFileSync(`${up}/icons/svg/${path}.svg`, "utf8");
  const r = sanitizeSvg(raw, { maxBytes: 200000 });
  if (!r.ok) throw new Error(`${path}: ${r.reason}`);
  const body = round(r.svg.body).replaceAll("__PCID__-", "k");
  const vb = round(r.svg.viewBox);
  writeFileSync(
    `${out}/svg/${id}.svg`,
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}">${body}</svg>\n`,
  );
  if (body.length > 8192) throw new Error(`${id} exceeds the 8 KB budget`);
  icons.push({
    id,
    aliases,
    category,
    provider: "kubernetes",
    tags,
    file: `svg/${id}.svg`,
    sourceUrl: `https://github.com/kubernetes/community/blob/${sha}/icons/svg/${path}.svg`,
    monochrome: false,
  });
}
icons.sort((a, b) => (a.id < b.id ? -1 : 1));
const manifest = {
  manifestVersion: 1,
  pack: {
    id: "k8s",
    name: "Kubernetes icons",
    version: `community@${sha.slice(0, 12)}`,
    license: "Apache-2.0",
    licenseUrl: "https://www.apache.org/licenses/LICENSE-2.0",
    attribution:
      "Kubernetes Icons Set, Copyright The Kubernetes Authors, Apache-2.0 (used under the Apache-2.0 option of Apache-2.0 or CC-BY-4.0). Modified: editor metadata removed, numbers rounded.",
    trademarkNotice:
      "Kubernetes is a registered trademark of The Linux Foundation; use of the Kubernetes logo as a trademark is subject to the Linux Foundation Trademark Usage Guidelines (https://www.linuxfoundation.org/legal/trademark-usage).",
    source: "https://github.com/kubernetes/community/tree/main/icons",
    redistributable: true,
  },
  icons,
};
writeFileSync(`${out}/icons.json`, JSON.stringify(manifest, null, 2) + "\n");
console.log(icons.length);
