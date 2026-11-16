/**
 * Reads the text out of a file the student picks: PDF, Word (.docx), or any
 * plain-text format. Everything happens in the browser; the file itself is
 * never uploaded anywhere. Only the extracted text is later sent, in parts,
 * to the language model that teaches from it.
 *
 * The PDF and Word libraries are large, so they are loaded on first use.
 */
const TEXT_TYPES = /\.(txt|md|markdown|tex|csv|json|html?|rst|py|js|c|cpp|m)$/i;

async function readPdf(file) {
  const pdfjs = await import('pdfjs-dist');
  const worker = await import('pdfjs-dist/build/pdf.worker.min.mjs?url');
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  const task = pdfjs.getDocument({ data: await file.arrayBuffer() });
  try {
    const pdf = await task.promise;
    const pages = [];
    for (let n = 1; n <= pdf.numPages; n += 1) {
      const page = await pdf.getPage(n);
      const content = await page.getTextContent();
      pages.push(content.items.map((item) => (item.str ?? '') + (item.hasEOL ? '\n' : ' ')).join(''));
    }
    return { text: pages.join('\n\n'), detail: `${pages.length} page${pages.length === 1 ? '' : 's'}` };
  } finally {
    await task.destroy?.().catch(() => {}); // frees the worker's copy of the file
  }
}

async function readDocx(file) {
  const module = await import('mammoth/mammoth.browser.js');
  const mammoth = module.default ?? module;
  const result = await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
  return { text: result.value, detail: 'Word document' };
}

/** @returns {Promise<{ name: string, text: string, detail: string }>} */
export async function readDocument(file) {
  const name = file.name || 'document';
  let read;
  if (/\.pdf$/i.test(name) || file.type === 'application/pdf') read = await readPdf(file);
  else if (/\.docx$/i.test(name)) read = await readDocx(file);
  else if (/\.doc$/i.test(name)) throw new Error('Old .doc files cannot be read here. Save the file as .docx or PDF and try again.');
  else if (TEXT_TYPES.test(name) || file.type.startsWith('text/')) read = { text: await file.text(), detail: 'text file' };
  else throw new Error('That file type cannot be read here. Use a PDF, a Word .docx file, or a text file.');

  const text = read.text.replace(/\u0000/g, '').trim();
  if (text.replace(/\s/g, '').length < 200) {
    throw new Error('Almost no text could be read from that file. If it is a scan, it has pictures of pages instead of text; use a version with selectable text.');
  }
  return { name, text, detail: read.detail };
}
