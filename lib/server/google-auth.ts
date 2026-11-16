// The service's own Google Cloud identity. On Cloud Run the metadata server hands out a
// short-lived token for the service account, so no key is stored anywhere.
const METADATA = "http://metadata.google.internal/computeMetadata/v1";

let token: { value: string; until: number } | undefined;
let project: string | undefined;

async function metadata(pathname: string): Promise<Response> {
  const res = await fetch(`${METADATA}/${pathname}`, { headers: { "Metadata-Flavor": "Google" }, signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`metadata server: HTTP ${res.status}`);
  return res;
}

export async function googleProject(): Promise<string> {
  // Read on every call when set in the environment, so tests and local runs can change it.
  if (process.env.GOOGLE_CLOUD_PROJECT) return process.env.GOOGLE_CLOUD_PROJECT;
  project ??= (await (await metadata("project/project-id")).text()).trim();
  return project;
}

export async function googleAccessToken(): Promise<string> {
  // For running outside Google Cloud: a short-lived token from `gcloud auth print-access-token`.
  if (process.env.GOOGLE_ACCESS_TOKEN) return process.env.GOOGLE_ACCESS_TOKEN;
  if (token && token.until > Date.now()) return token.value;
  const body = (await (await metadata("instance/service-accounts/default/token")).json()) as { access_token: string; expires_in: number };
  token = { value: body.access_token, until: Date.now() + (body.expires_in - 120) * 1000 };
  return token.value;
}
