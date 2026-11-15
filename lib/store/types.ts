// Document knowledge bases: what the implementer ("מטמיע") builds and the technician asks.
// A knowledge base is a named set of documents; each document is stored as numbered passages
// (a PDF page, or a slice of a longer text) so every answer can point at its source.

export type DocOrigin = "manufacturer" | "customer";

export type KbMeta = {
  id: string;
  name: string;
  description: string;
  // False: answers come from the documents only, with no suggested checks from general knowledge.
  ideas?: boolean;
  createdAt: string;
  updatedAt: string;
};

export type Passage = { n: number; text: string };

export type DocMeta = {
  id: string;
  kbId: string;
  name: string;
  origin: DocOrigin;
  // "page" for a PDF (n is the real page number), "part" for everything else.
  unit: "page" | "part";
  mime: string;
  ext: string;
  bytes: number;
  passages: number;
  // Pages with no extractable text (scans, full-page drawings). They cannot be searched.
  empty: number;
  chars: number;
  uploadedAt: string;
};

// How a knowledge base is used: one counter per kind of reply.
export type Usage = { questions: number; answer: number; ask: number; not_found: number; ideas: number; hazard: number; error: number; helpful: number; unhelpful: number; lastAt?: string };

// The meaning index of one document: a unit-length vector per passage number, and the embedding
// model that made them (vectors of different models cannot be compared).
export type DocVectors = { model: string; dims: number; byN: Map<number, Float32Array> };

export type StoredDoc = { meta: DocMeta; passages: Passage[]; vectors?: DocVectors };

// Where the bytes live. The file system driver is the default; a hosted deployment can swap in
// object storage without touching anything above this interface.
export interface BlobDriver {
  read(key: string): Promise<Buffer | null>;
  write(key: string, data: Buffer): Promise<void>;
  remove(prefix: string): Promise<void>;
  list(prefix: string): Promise<string[]>;
}
