// A minimal text PDF for tests: one content stream per page, built-in Helvetica.
export function makePdf(pages: string[]): Buffer {
  const objects: string[] = [];
  const add = (body: string) => objects.push(body) - 1 + 1; // 1-based object number
  const font = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  const pagesNumber = objects.length + 1 + pages.length * 2; // reserved below
  const kids: number[] = [];
  for (const text of pages) {
    const lines = text.split("\n").map((l) => `(${l.replace(/([()\\])/g, "\\$1")}) Tj T*`).join("\n");
    const stream = `BT /F1 12 Tf 14 TL 72 720 Td\n${lines}\nET`;
    const content = add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
    kids.push(add(`<< /Type /Page /Parent ${pagesNumber} 0 R /MediaBox [0 0 612 792] /Contents ${content} 0 R /Resources << /Font << /F1 ${font} 0 R >> >> >>`));
  }
  const pagesObject = add(`<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(" ")}] /Count ${kids.length} >>`);
  const catalog = add(`<< /Type /Catalog /Pages ${pagesObject} 0 R >>`);
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}
