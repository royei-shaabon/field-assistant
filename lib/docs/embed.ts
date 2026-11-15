// Turns text into vectors, so search can match by meaning and not only by shared words: a
// Hebrew question finds an English manual page, and "won't crank" finds "starter does not turn".
// The vectors come from an embedding model outside this service. Without one configured,
// search stays keyword-only and everything else works as before.

export interface Embedder {
  // Vectors of different models cannot be compared, so every stored vector carries this name.
  readonly model: string;
  // One unit-length vector per text. "document" for passages, "query" for a search.
  embed(texts: string[], kind: "document" | "query"): Promise<Float32Array[]>;
}

// How much of a passage is embedded. Longer passages are cut; keyword search still covers the rest.
export const EMBED_CHARS = 6000;

export function normalize(values: ArrayLike<number>): Float32Array {
  const v = Float32Array.from(values);
  let sum = 0;
  for (const x of v) sum += x * x;
  const length = Math.sqrt(sum) || 1;
  for (let i = 0; i < v.length; i++) v[i] /= length;
  return v;
}

const METADATA = "http://metadata.google.internal/computeMetadata/v1";

// Google Vertex AI text embeddings. On Cloud Run the service's own identity is used (no key to
// store): the service account needs the "Vertex AI User" role, and the Vertex AI API enabled.
export class VertexEmbedder implements Embedder {
  readonly model = process.env.EMBED_MODEL || "text-multilingual-embedding-002";
  private location = process.env.EMBED_LOCATION || "us-central1";
  // Texts per request. Some models accept one text per request: set EMBED_BATCH=1 for those.
  private batch = Math.max(1, Number(process.env.EMBED_BATCH) || 16);
  private token?: { value: string; until: number };
  private projectId?: string;

  private async metadata(pathname: string): Promise<Response> {
    const res = await fetch(`${METADATA}/${pathname}`, { headers: { "Metadata-Flavor": "Google" }, signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`metadata server: HTTP ${res.status}`);
    return res;
  }

  private async project(): Promise<string> {
    this.projectId ??= process.env.GOOGLE_CLOUD_PROJECT || (await (await this.metadata("project/project-id")).text()).trim();
    return this.projectId;
  }

  private async accessToken(): Promise<string> {
    // For running outside Google Cloud: a short-lived token from `gcloud auth print-access-token`.
    if (process.env.GOOGLE_ACCESS_TOKEN) return process.env.GOOGLE_ACCESS_TOKEN;
    if (this.token && this.token.until > Date.now()) return this.token.value;
    const body = (await (await this.metadata("instance/service-accounts/default/token")).json()) as { access_token: string; expires_in: number };
    this.token = { value: body.access_token, until: Date.now() + (body.expires_in - 120) * 1000 };
    return this.token.value;
  }

  private async request(texts: string[], kind: "document" | "query"): Promise<Float32Array[]> {
    const url = `https://${this.location}-aiplatform.googleapis.com/v1/projects/${await this.project()}/locations/${this.location}/publishers/google/models/${this.model}:predict`;
    const task_type = kind === "query" ? "RETRIEVAL_QUERY" : "RETRIEVAL_DOCUMENT";
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${await this.accessToken()}`, "Content-Type": "application/json" },
      body: JSON.stringify({ instances: texts.map((content) => ({ content, task_type })), parameters: { autoTruncate: true } }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      const detail = ((await res.json().catch(() => null)) as { error?: { message?: string } } | null)?.error?.message ?? "";
      // A batch the model refuses (too many texts, too many tokens) is retried one text at a time.
      if (res.status === 400 && texts.length > 1) {
        const out: Float32Array[] = [];
        for (const t of texts) out.push(...(await this.request([t], kind)));
        return out;
      }
      throw new Error(`embeddings HTTP ${res.status}: ${detail}`.slice(0, 400));
    }
    const body = (await res.json()) as { predictions?: { embeddings?: { values?: number[] } }[] };
    const vectors = (body.predictions ?? []).map((p) => p.embeddings?.values);
    if (vectors.length !== texts.length || vectors.some((v) => !v?.length)) throw new Error("embeddings: unexpected response");
    return vectors.map((v) => normalize(v!));
  }

  async embed(texts: string[], kind: "document" | "query"): Promise<Float32Array[]> {
    const out: Float32Array[] = [];
    let group: string[] = [];
    let chars = 0;
    const flush = async () => {
      if (group.length) out.push(...(await this.request(group, kind)));
      group = [];
      chars = 0;
    };
    for (const raw of texts) {
      const text = raw.slice(0, EMBED_CHARS) || " ";
      if (group.length >= this.batch || chars + text.length > 24_000) await flush();
      group.push(text);
      chars += text.length;
    }
    await flush();
    return out;
  }
}

let shared: Embedder | null | undefined;

// EMBEDDINGS=vertex turns search by meaning on. Anything else: keyword search only.
export function embedder(): Embedder | null {
  if (shared === undefined) shared = process.env.EMBEDDINGS === "vertex" ? new VertexEmbedder() : null;
  return shared;
}
