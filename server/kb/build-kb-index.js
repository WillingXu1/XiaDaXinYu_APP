import fs from 'fs';
import path from 'path';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import {
  DEFAULT_CHUNK_OVERLAP,
  DEFAULT_CHUNK_SIZE,
  KB_INDEX_JSONL,
  KB_META_JSON,
  KB_SOURCE_DIR,
  KB_SOURCE_PDF
} from './constants.js';

const normalizeText = (value = '') => {
  return value
    .replace(/\u0000/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\s*([。！？；，,.;!?])\s*/g, '$1')
    .trim();
};

const splitBySentence = (text) => {
  const segments = text
    .split(/(?<=[。！？!?；;])/)
    .map((item) => item.trim())
    .filter(Boolean);

  return segments.length ? segments : [text];
};

const chunkText = (text, maxLen, overlap) => {
  if (!text) return [];

  const sentences = splitBySentence(text);
  const chunks = [];
  let current = '';

  for (const sentence of sentences) {
    if ((current + sentence).length <= maxLen) {
      current += sentence;
      continue;
    }

    if (current) {
      chunks.push(current);
    }

    if (sentence.length <= maxLen) {
      current = sentence;
      continue;
    }

    let start = 0;
    while (start < sentence.length) {
      const end = Math.min(sentence.length, start + maxLen);
      const piece = sentence.slice(start, end);
      if (piece.trim()) {
        chunks.push(piece.trim());
      }
      if (end >= sentence.length) {
        break;
      }
      start = Math.max(0, end - overlap);
    }

    current = '';
  }

  if (current.trim()) {
    chunks.push(current.trim());
  }

  return chunks;
};

const toPageText = async (pdf, pageNumber) => {
  const page = await pdf.getPage(pageNumber);
  const content = await page.getTextContent();
  const text = content.items
    .map((item) => ('str' in item ? item.str : ''))
    .join(' ');
  return normalizeText(text);
};

const resolveSourcePdfs = () => {
  if (KB_SOURCE_PDF) {
    const absPdf = path.resolve(KB_SOURCE_PDF);
    if (!fs.existsSync(absPdf)) {
      throw new Error(`KB source PDF not found: ${absPdf}`);
    }
    return [absPdf];
  }

  const absDir = path.resolve(KB_SOURCE_DIR);
  if (!fs.existsSync(absDir)) {
    throw new Error(`KB source directory not found: ${absDir}`);
  }

  const files = fs.readdirSync(absDir)
    .filter((name) => name.toLowerCase().endsWith('.pdf'))
    .map((name) => path.join(absDir, name));

  if (!files.length) {
    throw new Error(`No PDF files found under KB source directory: ${absDir}`);
  }

  return files;
};

const indexSinglePdf = async ({ sourcePdf, writeStream, chunkIdStart }) => {
  const raw = fs.readFileSync(sourcePdf);
  const loadingTask = getDocument({ data: new Uint8Array(raw) });
  const pdf = await loadingTask.promise;

  let chunkId = chunkIdStart;
  let chunkCount = 0;
  let extractedCharCount = 0;

  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const pageText = await toPageText(pdf, pageNumber);
    if (!pageText) {
      continue;
    }

    extractedCharCount += pageText.length;
    const chunks = chunkText(pageText, DEFAULT_CHUNK_SIZE, DEFAULT_CHUNK_OVERLAP);

    for (const chunk of chunks) {
      const payload = {
        id: `chunk_${chunkId}`,
        source: path.basename(sourcePdf),
        page: pageNumber,
        content: chunk
      };
      writeStream.write(`${JSON.stringify(payload)}\n`);
      chunkId += 1;
      chunkCount += 1;
    }

    if (pageNumber % 50 === 0) {
      console.log(`[KB] ${path.basename(sourcePdf)} pages: ${pageNumber}/${pdf.numPages}, total chunks for file: ${chunkCount}`);
    }
  }

  const warning = chunkCount < 20
    ? '该 PDF 可提取文本极少，可能为扫描版，建议先 OCR。'
    : null;

  return {
    nextChunkId: chunkId,
    fileMeta: {
      source: sourcePdf,
      sourceName: path.basename(sourcePdf),
      numPages: pdf.numPages,
      chunkCount,
      extractedCharCount,
      warning
    }
  };
};

const buildIndex = async () => {
  const sourcePdfs = resolveSourcePdfs();

  const outputJsonl = path.resolve(KB_INDEX_JSONL);
  const outputMeta = path.resolve(KB_META_JSON);

  fs.mkdirSync(path.dirname(outputJsonl), { recursive: true });

  const writeStream = fs.createWriteStream(outputJsonl, { encoding: 'utf8' });

  let chunkId = 0;
  let totalChunkCount = 0;
  let totalExtractedChars = 0;
  let totalPages = 0;
  const sourceMeta = [];
  const startedAt = Date.now();

  for (const sourcePdf of sourcePdfs) {
    console.log(`[KB] indexing: ${sourcePdf}`);
    const result = await indexSinglePdf({
      sourcePdf,
      writeStream,
      chunkIdStart: chunkId
    });
    chunkId = result.nextChunkId;
    sourceMeta.push(result.fileMeta);
    totalChunkCount += result.fileMeta.chunkCount;
    totalExtractedChars += result.fileMeta.extractedCharCount;
    totalPages += result.fileMeta.numPages;
  }

  await new Promise((resolve) => writeStream.end(resolve));

  const lowTextFiles = sourceMeta.filter((item) => item.warning).map((item) => item.sourceName);
  const warning = lowTextFiles.length
    ? `以下文件可提取文本极少，可能为扫描版，建议先 OCR：${lowTextFiles.join('、')}`
    : null;

  const meta = {
    sourceDir: path.resolve(KB_SOURCE_DIR),
    sourceFiles: sourcePdfs,
    sources: sourceMeta,
    chunksFile: outputJsonl,
    chunkCount: totalChunkCount,
    extractedCharCount: totalExtractedChars,
    numPages: totalPages,
    chunkSize: DEFAULT_CHUNK_SIZE,
    chunkOverlap: DEFAULT_CHUNK_OVERLAP,
    warning,
    builtAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt
  };

  fs.writeFileSync(outputMeta, JSON.stringify(meta, null, 2), 'utf8');

  console.log('[KB] index built successfully');
  console.log(`[KB] sourceFiles=${sourcePdfs.length}, pages=${meta.numPages}, chunks=${meta.chunkCount}, durationMs=${meta.durationMs}`);
  if (warning) {
    console.warn(`[KB] warning: ${warning}`);
  }
  console.log(`[KB] chunks file: ${outputJsonl}`);
  console.log(`[KB] meta file: ${outputMeta}`);
};

buildIndex().catch((error) => {
  console.error('[KB] build failed:', error);
  process.exit(1);
});
