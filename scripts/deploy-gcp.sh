#!/usr/bin/env bash
# Deploys the app to Google Cloud Run, with the knowledge bases on a Cloud Storage bucket
# mounted at /data. Run it from the repository root in Google Cloud Shell (already signed in).
# Safe to run again: it updates the same service and keeps the bucket.
set -euo pipefail

SERVICE="${SERVICE:-field-assistant}"
REGION="${REGION:-me-west1}"
PROJECT="$(gcloud config get-value project 2>/dev/null)"
if [ -z "$PROJECT" ] || [ "$PROJECT" = "(unset)" ]; then
  echo "No Google Cloud project is selected. Run: gcloud config set project YOUR_PROJECT_ID" >&2
  exit 1
fi
BUCKET="${BUCKET:-${PROJECT}-${SERVICE}-data}"

echo "Project: $PROJECT   Region: $REGION   Service: $SERVICE   Bucket: $BUCKET"

# Secrets are typed here and never stored in the repository or the shell history.
read -r -s -p "Anthropic API key (ANTHROPIC_API_KEY): " ANTHROPIC_API_KEY; echo
read -r -s -p "Password for the implementer area /admin (ADMIN_PASSWORD): " ADMIN_PASSWORD; echo
read -r -p "Access code for technicians (ACCESS_CODE), at least 6 characters: " ACCESS_CODE
if [ -z "$ANTHROPIC_API_KEY" ] || [ -z "$ADMIN_PASSWORD" ] || [ -z "$ACCESS_CODE" ]; then
  echo "All three values are required." >&2
  exit 1
fi
if [ "${#ACCESS_CODE}" -lt 6 ] || [ "${#ADMIN_PASSWORD}" -lt 10 ]; then
  echo "Use at least 6 characters for the access code and 10 for the admin password." >&2
  exit 1
fi
case "$ANTHROPIC_API_KEY$ADMIN_PASSWORD$ACCESS_CODE" in
  *\"* | *\\*) echo "Values cannot contain a double quote or a backslash." >&2; exit 1 ;;
esac
# Signs the session cookies. A new one on every deploy signs everyone out, which is fine.
SESSION_SECRET="$(head -c 32 /dev/urandom | base64 | tr -d '\n/+=')"

echo "Enabling the Google Cloud services this needs (takes a minute the first time)..."
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com storage.googleapis.com

if ! gcloud storage buckets describe "gs://$BUCKET" >/dev/null 2>&1; then
  gcloud storage buckets create "gs://$BUCKET" --location="$REGION" --uniform-bucket-level-access
fi

# The service runs as the default compute service account; it needs to read and write the bucket.
NUMBER="$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')"
gcloud storage buckets add-iam-policy-binding "gs://$BUCKET" \
  --member="serviceAccount:${NUMBER}-compute@developer.gserviceaccount.com" \
  --role="roles/storage.objectAdmin" >/dev/null

ENV_FILE="$(mktemp)"
trap 'rm -f "$ENV_FILE"' EXIT
chmod 600 "$ENV_FILE"
{
  printf 'ANTHROPIC_API_KEY: "%s"\n' "$ANTHROPIC_API_KEY"
  printf 'ADMIN_PASSWORD: "%s"\n' "$ADMIN_PASSWORD"
  printf 'ACCESS_CODE: "%s"\n' "$ACCESS_CODE"
  printf 'SESSION_SECRET: "%s"\n' "$SESSION_SECRET"
  printf 'HIDE_SAMPLE_KB: "1"\n'
  printf 'DATA_DIR: "/data"\n'
} > "$ENV_FILE"

# One instance at most: the search index and the usage counters live in that instance.
gcloud run deploy "$SERVICE" \
  --source . \
  --region "$REGION" \
  --allow-unauthenticated \
  --execution-environment gen2 \
  --memory 1Gi \
  --max-instances 1 \
  --timeout 300 \
  --add-volume "name=data,type=cloud-storage,bucket=$BUCKET" \
  --add-volume-mount "volume=data,mount-path=/data" \
  --env-vars-file "$ENV_FILE"

URL="$(gcloud run services describe "$SERVICE" --region "$REGION" --format='value(status.url)')"
echo
echo "Deployed."
echo "Technician screen:  $URL"
echo "Implementer screen: $URL/admin"
