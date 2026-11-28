// Document knowledge bases: what the implementer ("מטמיע") builds and the technician asks.
// A knowledge base is a named set of documents; each document is stored as numbered passages
// (a PDF page, or a slice of a longer text) so every answer can point at its source.

// "team": what the customer's own technicians learned in the field, approved by the implementer.
// "field": what one technician reported and nobody has checked yet. It is searched at once and
// shown as exactly that, until the implementer approves it (then it is "team") or removes it.
export type DocOrigin = "manufacturer" | "customer" | "team" | "field";

// One piece of field knowledge: a fault and what solved it, in the words of whoever wrote it.
// It waits as `pending` until the implementer approves it; only approved notes are searched.
// `n`: its number in the team's document, given once at approval and never reused.
export type NoteFrom = "technician" | "implementer" | "whatsapp" | "conversations";
// `f`: its number among the notes that are shown before they were checked. `held`: it touches
// a hazard topic, so it is not shown to anybody until the implementer approves it.
export type Note = { id: string; kbId: string; text: string; from: NoteFrom; status: "pending" | "approved" | "rejected"; n?: number; f?: number; held?: true; by?: string; createdAt: string; decidedAt?: string };

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

// `own`: how many characters of `text` came from the file itself. What follows was read from
// the page's picture by a model (lib/docs/read-pages.ts). Absent when all of it is the file's.
export type Passage = { n: number; text: string; own?: number };

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
  // What the document is and what it is the right source for, as the implementer approved it
  // (the model drafts it). The assistant reads it in its list of documents.
  about?: string;
  // The model years the document covers ("2017-2018"). Shown beside the source of every answer.
  years?: string;
  // Pages that were read from their picture (whether or not anything was added), so they are not read twice.
  pictured?: number[];
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
