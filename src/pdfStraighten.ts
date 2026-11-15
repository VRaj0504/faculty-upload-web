// Turns sideways PDF pages upright before a file is filed in Resources.
//
// Slides saved with "Print to PDF" on portrait paper end up with every page lying on its side. For each page
// this reads which way the text runs. If at least 80% of the characters run the same way and that way is not
// upright, the page's rotation setting is changed so viewers show it upright. Only the setting changes; the
// page is not redrawn or recompressed. Pages with little or no text (scans, photos) are left alone.
//
// The same logic lives in the app repo at scripts/lib/pdfStraighten.js (used to fix files already uploaded).
import { getPdfjs } from './timetableImport';

const MIN_CHARS = 20;
const MIN_SHARE = 0.8;
/** Bigger files are filed as they are: checking them would freeze the tab. */
const MAX_BYTES = 40 * 1024 * 1024;

type PageRotation = { current: number; wanted: number | null };

async function pageRotations(bytes: Uint8Array): Promise<PageRotation[]> {
  const pdfjs = await getPdfjs();
  // pdf.js takes ownership of the bytes it is given, so hand it a copy.
  const task = pdfjs.getDocument({ data: bytes.slice(), verbosity: 0 });
  const doc = await task.promise;
  const out: PageRotation[] = [];
  try {
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const current = ((page.rotate % 360) + 360) % 360;
      const text = await page.getTextContent();
      const chars: Record<number, number> = { 0: 0, 90: 0, 180: 0, 270: 0 };
      let total = 0;
      for (const item of text.items) {
        if (!('str' in item) || !item.transform) continue;
        const len = item.str.trim().length;
        const [a, b] = item.transform as number[];
        if (!len || (!a && !b)) continue;
        const angle = (((Math.round((Math.atan2(b, a) * 180) / Math.PI / 90) * 90) % 360) + 360) % 360;
        chars[angle] += len;
        total += len;
      }
      let wanted: number | null = null;
      if (total >= MIN_CHARS) {
        const best = [0, 90, 180, 270].reduce((x, y) => (chars[y] > chars[x] ? y : x));
        if (chars[best] / total >= MIN_SHARE) wanted = best;
      }
      out.push({ current, wanted });
      page.cleanup();
    }
  } finally {
    await task.destroy();
  }
  return out;
}

/**
 * Returns the file to upload and how many pages were turned.
 * Never throws: if the file is not a PDF, is too big, is locked, or anything goes wrong, the original file
 * comes back untouched with fixed = 0.
 */
export async function straightenPdfFile(file: File): Promise<{ file: File; fixed: number }> {
  const same = { file, fixed: 0 };
  const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
  if (!isPdf || file.size > MAX_BYTES) return same;
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const rotations = await pageRotations(bytes);
    const turn = rotations.map((r, i) => ({ i, ...r })).filter((r) => r.wanted !== null && r.wanted !== r.current);
    if (!turn.length) return same;

    const { PDFDocument, degrees } = await import('pdf-lib');
    const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
    const pages = pdf.getPages();
    if (pages.length !== rotations.length) return same;
    for (const t of turn) pages[t.i].setRotation(degrees(t.wanted as number));
    const fixedBytes = await pdf.save();

    // Check the result really is upright before using it.
    const after = await pageRotations(fixedBytes);
    if (after.length !== rotations.length || after.some((r) => r.wanted !== null && r.wanted !== r.current)) return same;

    const fixedFile = new File([fixedBytes as BlobPart], file.name, { type: 'application/pdf', lastModified: file.lastModified });
    return { file: fixedFile, fixed: turn.length };
  } catch {
    return same;
  }
}
