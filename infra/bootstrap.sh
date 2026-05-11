#!/usr/bin/env bash
# ============================================================
#  keikhi monorepo : Google Cloud one-shot bootstrap
#  Run in Cloud Shell. Idempotent — safe to re-run.
#  Provisions shared resources, then per-app resources for
#  every directory under apps/ that contains an app.yaml.
# ============================================================
set -euo pipefail

REGION="${REGION:-asia-northeast1}"
REPO_NAME="${REPO_NAME:-keikhi}"
DB_INSTANCE="${DB_INSTANCE:-keikhi-db}"
GITHUB_OWNER="${GITHUB_OWNER:-banaxart-jpg}"
GITHUB_REPO="${GITHUB_REPO:-keikhi}"

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

step() { printf "\n\033[1;33m▶ %s\033[0m\n" "$*"; }
sub()  { printf "  • %s\n" "$*"; }

PROJECT_ID="${PROJECT_ID:-$(gcloud config get-value project 2>/dev/null || true)}"
if [[ -z "$PROJECT_ID" ]]; then
  read -rp "GCP Project ID: " PROJECT_ID
fi
gcloud config set project "$PROJECT_ID"
PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')"
CB_SA="${PROJECT_NUMBER}@cloudbuild.gserviceaccount.com"

# ────────────────────────────────────────────────────────────
# Shared resources (one-time)
# ────────────────────────────────────────────────────────────

step "Enable APIs"
gcloud services enable \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  secretmanager.googleapis.com \
  sqladmin.googleapis.com \
  storage.googleapis.com \
  artifactregistry.googleapis.com \
  iam.googleapis.com \
  generativelanguage.googleapis.com \
  aiplatform.googleapis.com \
  vision.googleapis.com \
  documentai.googleapis.com

step "Artifact Registry repo: ${REPO_NAME}"
gcloud artifacts repositories describe "$REPO_NAME" --location="$REGION" >/dev/null 2>&1 || \
  gcloud artifacts repositories create "$REPO_NAME" \
    --repository-format=docker --location="$REGION" \
    --description="${REPO_NAME} container images"

step "Shared Gemini API key (Secret Manager: gemini-api-key)"
if ! gcloud secrets describe gemini-api-key >/dev/null 2>&1; then
  read -srp "  Gemini API key (input hidden): " GEMINI_KEY; echo
  printf "%s" "$GEMINI_KEY" | gcloud secrets create gemini-api-key \
    --replication-policy=automatic --data-file=-
else
  sub "already exists. To rotate: gcloud secrets versions add gemini-api-key --data-file=-"
fi

step "Shared Cloud SQL instance: ${DB_INSTANCE}"
if ! gcloud sql instances describe "$DB_INSTANCE" >/dev/null 2>&1; then
  ROOT_PW="$(openssl rand -base64 24)"
  gcloud sql instances create "$DB_INSTANCE" \
    --database-version=POSTGRES_15 \
    --tier=db-f1-micro \
    --region="$REGION" \
    --storage-size=10GB \
    --storage-auto-increase \
    --no-backup \
    --root-password="$ROOT_PW"
  sub "Postgres superuser password: ${ROOT_PW}  (save this!)"
fi

step "Grant Cloud Build SA the roles it needs"
# Newer GCP projects (post-2024-04-29) default to the Compute SA for Cloud Build.
# Older projects use the dedicated Cloud Build SA. Grant to both so it works either way.
CB_SA_LEGACY="${PROJECT_NUMBER}@cloudbuild.gserviceaccount.com"
CB_SA_COMPUTE="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"
for SA in "$CB_SA_LEGACY" "$CB_SA_COMPUTE"; do
  for ROLE in \
    roles/run.admin \
    roles/iam.serviceAccountUser \
    roles/artifactregistry.writer \
    roles/secretmanager.secretAccessor \
    roles/cloudsql.client \
    roles/storage.objectViewer \
    roles/logging.logWriter
  do
    gcloud projects add-iam-policy-binding "$PROJECT_ID" \
      --member="serviceAccount:${SA}" --role="$ROLE" \
      --condition=None --quiet >/dev/null 2>&1 || true
  done
done

# ────────────────────────────────────────────────────────────
# Per-app loop
# ────────────────────────────────────────────────────────────

for APP_DIR in "$ROOT_DIR"/apps/*/; do
  APP="$(basename "$APP_DIR")"
  APP_YAML="${APP_DIR}app.yaml"

  if [[ ! -f "$APP_YAML" ]]; then
    sub "skip ${APP} (no app.yaml)"
    continue
  fi

  # Parse app.yaml — simple key:value, ignore comments.
  eval "$(grep -E '^[a-zA-Z_][a-zA-Z0-9_]*:' "$APP_YAML" | sed -E 's/^([a-zA-Z_][a-zA-Z0-9_]*):[[:space:]]*"?([^"#]*)"?[[:space:]]*(#.*)?$/APP_\1="\2"/' )"

  SERVICE="${APP_SERVICE:-${APP}-api}"
  SA_NAME="${APP_SA:-${APP}-run}"
  SA_EMAIL="${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
  DB_NAME="${APP_DB_NAME:-${APP}}"
  DB_USER="${APP_DB_USER:-${APP}}"
  DB_PW_SECRET="${APP_DB_PW_SECRET:-${APP}-db-password}"
  BUCKET="${APP_BUCKET:-${PROJECT_ID}-${APP}-receipts}"
  HAS_DB="${APP_HAS_DB:-true}"
  HAS_BUCKET="${APP_HAS_BUCKET:-true}"
  CLOUDBUILD="${APP_CLOUDBUILD:-apps/${APP}/cloudbuild.yaml}"

  step "App: ${APP}  (service=${SERVICE})"

  sub "service account ${SA_EMAIL}"
  gcloud iam service-accounts describe "$SA_EMAIL" >/dev/null 2>&1 || \
    gcloud iam service-accounts create "$SA_NAME" --display-name="${APP} Cloud Run runtime"

  if [[ "$HAS_DB" == "true" ]]; then
    sub "database ${DB_NAME}"
    gcloud sql databases describe "$DB_NAME" --instance="$DB_INSTANCE" >/dev/null 2>&1 || \
      gcloud sql databases create "$DB_NAME" --instance="$DB_INSTANCE"

    if ! gcloud secrets describe "$DB_PW_SECRET" >/dev/null 2>&1; then
      DB_PW="$(openssl rand -base64 24)"
      gcloud sql users create "$DB_USER" --instance="$DB_INSTANCE" --password="$DB_PW" 2>/dev/null || \
        gcloud sql users set-password "$DB_USER" --instance="$DB_INSTANCE" --password="$DB_PW"
      printf "%s" "$DB_PW" | gcloud secrets create "$DB_PW_SECRET" \
        --replication-policy=automatic --data-file=-
    fi

    if [[ -f "${APP_DIR}infra/schema.sql" ]]; then
      sub "apply schema (best-effort; run manually if this fails)"
      DB_PW_VAL="$(gcloud secrets versions access latest --secret="$DB_PW_SECRET")"
      PGPASSWORD="$DB_PW_VAL" gcloud sql connect "$DB_INSTANCE" --user="$DB_USER" --database="$DB_NAME" --quiet \
        < "${APP_DIR}infra/schema.sql" 2>/dev/null || \
        sub "↑ skipped — run manually:  gcloud sql connect $DB_INSTANCE --user=$DB_USER --database=$DB_NAME < ${APP_DIR}infra/schema.sql"
    fi
  fi

  if [[ "$HAS_BUCKET" == "true" ]]; then
    sub "bucket gs://${BUCKET}"
    gcloud storage buckets describe "gs://${BUCKET}" >/dev/null 2>&1 || \
      gcloud storage buckets create "gs://${BUCKET}" --location="$REGION" --uniform-bucket-level-access
  fi

  sub "runtime SA permissions"
  for ROLE in \
    roles/secretmanager.secretAccessor \
    roles/cloudsql.client \
    roles/storage.objectAdmin \
    roles/logging.logWriter
  do
    gcloud projects add-iam-policy-binding "$PROJECT_ID" \
      --member="serviceAccount:${SA_EMAIL}" --role="$ROLE" \
      --condition=None --quiet >/dev/null
  done

  sub "Cloud Build trigger ${SERVICE}-deploy"
  if gcloud builds triggers describe "${SERVICE}-deploy" --region="$REGION" >/dev/null 2>&1; then
    sub "  trigger already exists"
  else
    gcloud builds triggers create github \
      --name="${SERVICE}-deploy" \
      --repo-owner="$GITHUB_OWNER" \
      --repo-name="$GITHUB_REPO" \
      --branch-pattern='^(main|claude/.*)$' \
      --build-config="$CLOUDBUILD" \
      --included-files="apps/${APP}/**" \
      --region="$REGION" 2>/dev/null || \
      sub "  ⚠ skipped — connect the GitHub repo to Cloud Build first:"
      sub "    https://console.cloud.google.com/cloud-build/triggers/connect?project=${PROJECT_ID}"
      sub "    then re-run this script."
  fi
done

step "Done."
cat <<EOF

  First manual deploy of any app:
    gcloud builds submit --config=apps/<app>/cloudbuild.yaml --region=${REGION} .

  Service URLs:
    gcloud run services list --region=${REGION}
EOF
