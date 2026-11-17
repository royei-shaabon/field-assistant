// A page of a manual holds several subjects: a table of faults, a list of warnings, a
// procedure. Searching whole pages finds the page and loses the subject, so search works on
// sections: runs of lines that belong together, a few hundred characters each. A section
// always knows its page, and the page stays the unit that answers cite and that quotes are
// checked against.

// Changes when the way pages are cut changes: vectors made for other sections are then stale.
export const SECTIONS_VERSION = 1;

// The name vectors are stored under: the embedding model and the way the text was cut.
export const vectorModel = (embeddingModel: string) => `${embeddingModel}#s${SECTIONS_VERSION}`;

// A section's vector is stored under one number: its page (or part) and its place on it.
export const sectionKey = (n: number, c: number) => n * 1000 + c;

const TARGET = 650;
const MAX = 1100;
const MIN = 160;

// A line that opens something new: a bullet, a numbered step, a heading in capitals, a question.
const OPENS = /^\s*(?:[•●▪■◦*\-–]\s|\(?\d{1,2}[.)]\s|[A-Z][A-Z0-9 ,/&'()-]{5,}$)/;

export function sections(text: string): string[] {
  const out: string[] = [];
  let now: string[] = [];
  let size = 0;
  let blank = false;
  const flush = () => {
    const joined = now.join("\n").trim();
    if (joined) out.push(joined);
    now = [];
    size = 0;
  };
  for (const line of text.split("\n")) {
    if (!line.trim()) {
      blank = true;
      continue;
    }
    const opens = blank || OPENS.test(line);
    blank = false;
    // Long enough and something new begins: cut here. Too long: cut anyway.
    if ((size >= TARGET && opens) || size + line.length > MAX) flush();
    // One line longer than a section (text without line breaks) is cut by length.
    for (let at = 0; at < line.length; at += MAX) {
      const piece = line.slice(at, at + MAX);
      if (size + piece.length > MAX) flush();
      now.push(piece);
      size += piece.length + 1;
    }
  }
  flush();
  // A scrap at the end (a page number, one stray line) joins the section before it.
  if (out.length > 1 && out.at(-1)!.length < MIN) {
    const last = out.pop()!;
    out[out.length - 1] += `\n${last}`;
  }
  return out;
}
