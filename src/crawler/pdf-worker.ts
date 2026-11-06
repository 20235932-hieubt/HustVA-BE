import { parentPort, workerData } from 'node:worker_threads';
import type { Block } from './types.js';

async function extract(): Promise<void> {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = getDocument({
    data: new Uint8Array(workerData as Uint8Array),
    useSystemFonts: true,
  });
  try {
    const pdf = await task.promise;
    if (pdf.numPages > 100) throw new Error('PDF vượt giới hạn 100 trang');
    const blocks: Block[] = [];
    for (let number = 1; number <= pdf.numPages; number++) {
      const page = await pdf.getPage(number);
      const content = await page.getTextContent();
      const lines: { y: number; items: { x: number; text: string }[] }[] = [];
      for (const item of content.items) {
        if (!('str' in item) || !item.str.trim()) continue;
        const y = item.transform[5];
        let line = lines.find((line) => Math.abs(line.y - y) < 2);
        if (!line) {
          line = { y, items: [] };
          lines.push(line);
        }
        line.items.push({ x: item.transform[4], text: item.str });
      }
      const text = lines
        .sort((a, b) => b.y - a.y)
        .map((line) =>
          line.items
            .sort((a, b) => a.x - b.x)
            .map((item) => item.text)
            .join(' '),
        )
        .join('\n')
        .trim();
      blocks.push({ id: `page-${number}`, type: 'pdf_page', page: number, text });
      page.cleanup();
    }
    parentPort?.postMessage({ blocks });
  } finally {
    await task.destroy();
  }
}
extract().catch((error) => parentPort?.postMessage({ error: (error as Error).message }));
