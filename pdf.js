// Minimal PDF writer: one JPEG per A4 page, optional Helvetica footer line.
// pages: [{ jpeg: Uint8Array, w: px, h: px }]; footer: string | null
export const PAPERS = {
  A4: { w: 595.28, h: 841.89 },
  Letter: { w: 612, h: 792 },
  Legal: { w: 612, h: 1008 },
};
export const MARGIN = 28.35;
export const FOOTER_H = 16;

const pdfText = (t) => t.replace(/[^\x20-\x7E]/g, '?').replace(/([\\()])/g, '\\$1');

export function buildPdf(pages, footer, paper) {
  const enc = new TextEncoder();
  const chunks = [];
  const offsets = [];
  let len = 0;
  const push = (d) => {
    const b = typeof d === 'string' ? enc.encode(d) : d;
    chunks.push(b);
    len += b.length;
  };
  const obj = (n, dict, stream) => {
    offsets[n] = len;
    push(`${n} 0 obj\n${dict}`);
    if (stream) {
      push('\nstream\n');
      push(stream);
      push('\nendstream');
    }
    push('\nendobj\n');
  };

  push('%PDF-1.4\n');
  push(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  const kids = pages.map((_, i) => `${6 + 3 * i} 0 R`).join(' ');
  obj(2, `<< /Type /Pages /Count ${pages.length} /Kids [${kids}] >>`);
  obj(3, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');

  const cw = paper.w - 2 * MARGIN;
  pages.forEach((p, i) => {
    const img = 4 + 3 * i;
    const dw = cw;
    const dh = (p.h / p.w) * cw;
    obj(
      img,
      `<< /Type /XObject /Subtype /Image /Width ${p.w} /Height ${p.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${p.jpeg.length} >>`,
      p.jpeg
    );
    let content = `q ${dw.toFixed(2)} 0 0 ${dh.toFixed(2)} ${MARGIN} ${(paper.h - MARGIN - dh).toFixed(2)} cm /Im0 Do Q`;
    if (footer) content += `\nBT /F1 7 Tf ${MARGIN} 14 Td (${pdfText(footer)}) Tj ET`;
    obj(img + 1, `<< /Length ${content.length} >>`, enc.encode(content));
    obj(
      img + 2,
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${paper.w} ${paper.h}] /Contents ${img + 1} 0 R /Resources << /XObject << /Im0 ${img} 0 R >> /Font << /F1 3 0 R >> >> >>`
    );
  });

  const count = 4 + 3 * pages.length;
  const xref = len;
  push(`xref\n0 ${count}\n0000000000 65535 f \n`);
  for (let n = 1; n < count; n++) push(`${String(offsets[n]).padStart(10, '0')} 00000 n \n`);
  push(`trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);

  return new Blob(chunks, { type: 'application/pdf' });
}
