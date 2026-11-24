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
  // Up to three questions the technician can start from with one tap, written by the implementer
  // for this machine. Without them the general ones are shown.
  starters?: string[];
  createdAt: string;
  updatedAt: string;
};

export type Passage = { n: number; text: string };

export type DocMeta = {
  id: string;
  kbId: string;
  // The manual's name as the technician sees it beside every answer. The implementer writes it
  // when uploading (the file's name is the suggestion) and can change it later.
  name: string;
  // The name the upload read from the file (its name without the ending). The duplicate check
  // goes by it, whatever the manual is called later. Absent on documents from before the two were told apart.
  file?: string;
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
