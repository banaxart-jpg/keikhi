import express from "express";
import { GoogleAuth } from "google-auth-library";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "public");

const {
  GCP_PROJECT,
  GCP_REGION = "asia-northeast1",
  PORT = 8080,
} = process.env;

const app = express();
app.use(express.json());

const auth = new GoogleAuth({ scopes: "https://www.googleapis.com/auth/cloud-platform" });
async function gapi(url) {
  const client = await auth.getClient();
  const res = await client.request({ url });
  return res.data;
}

app.get("/health", (req, res) =>
  res.json({ ok: true, project: GCP_PROJECT, region: GCP_REGION })
);

app.get("/api/config", (req, res) => {
  res.json({ projectId: GCP_PROJECT, region: GCP_REGION });
});

app.get("/api/services", async (req, res) => {
  try {
    const data = await gapi(
      `https://run.googleapis.com/v2/projects/${GCP_PROJECT}/locations/${GCP_REGION}/services`
    );
    const services = (data.services || []).map((s) => ({
      name: s.name?.split("/").pop(),
      url: s.uri,
      lastDeployed: s.updateTime,
      ready: (s.terminalCondition?.state || "") === "CONDITION_SUCCEEDED",
      conditionMsg: s.terminalCondition?.message || "",
      image: s.template?.containers?.[0]?.image,
    }));
    res.json({ services });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/sql", async (req, res) => {
  try {
    const data = await gapi(
      `https://sqladmin.googleapis.com/v1/projects/${GCP_PROJECT}/instances`
    );
    const instances = (data.items || []).map((i) => ({
      name: i.name,
      state: i.state,
      databaseVersion: i.databaseVersion,
      tier: i.settings?.tier,
      region: i.region,
      ip: i.ipAddresses?.[0]?.ipAddress,
      activationPolicy: i.settings?.activationPolicy,
    }));
    res.json({ instances });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/buckets", async (req, res) => {
  try {
    const data = await gapi(
      `https://storage.googleapis.com/storage/v1/b?project=${GCP_PROJECT}`
    );
    const buckets = (data.items || []).map((b) => ({
      name: b.name,
      location: b.location,
      storageClass: b.storageClass,
      created: b.timeCreated,
    }));
    res.json({ buckets });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/builds", async (req, res) => {
  try {
    const data = await gapi(
      `https://cloudbuild.googleapis.com/v1/projects/${GCP_PROJECT}/locations/${GCP_REGION}/builds?pageSize=10`
    );
    const builds = (data.builds || []).map((b) => ({
      id: b.id,
      status: b.status,
      startTime: b.startTime,
      finishTime: b.finishTime,
      logUrl: b.logUrl,
      triggerId: b.buildTriggerId,
      sourceArchive: b.source?.storageSource?.object,
    }));
    res.json({ builds });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/links", (req, res) => {
  const P = GCP_PROJECT;
  res.json({
    billing: {
      report: `https://console.cloud.google.com/billing/reports?project=${P}`,
      budgets: `https://console.cloud.google.com/billing/budgets?project=${P}`,
      overview: `https://console.cloud.google.com/billing?project=${P}`,
    },
    services: {
      cloudRun: `https://console.cloud.google.com/run?project=${P}`,
      cloudSql: `https://console.cloud.google.com/sql/instances?project=${P}`,
      cloudStorage: `https://console.cloud.google.com/storage/browser?project=${P}`,
      cloudBuild: `https://console.cloud.google.com/cloud-build/builds?project=${P}`,
      secretManager: `https://console.cloud.google.com/security/secret-manager?project=${P}`,
      artifactRegistry: `https://console.cloud.google.com/artifacts?project=${P}`,
      logs: `https://console.cloud.google.com/logs/query?project=${P}`,
      firebase: `https://console.firebase.google.com/project/${P}`,
    },
    ai: {
      aiStudio: `https://aistudio.google.com/apikey`,
      vertexAi: `https://console.cloud.google.com/vertex-ai?project=${P}`,
    },
  });
});

app.use(express.static(PUBLIC_DIR));
app.get("/", (req, res) => res.sendFile(path.join(PUBLIC_DIR, "index.html")));

app.listen(PORT, () => console.log(`keikhi-admin on ${PORT}`));
