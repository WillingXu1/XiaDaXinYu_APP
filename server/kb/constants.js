import path from 'path';

export const KB_SOURCE_DIR = process.env.KB_SOURCE_DIR || path.resolve(process.cwd(), 'resource', 'knowledges');
export const KB_SOURCE_PDF = process.env.KB_SOURCE_PDF || '';
export const KB_INDEX_JSONL = process.env.KB_INDEX_JSONL || path.resolve(process.cwd(), 'server', 'kb', 'index', 'clinical-guideline.chunks.jsonl');
export const KB_META_JSON = process.env.KB_META_JSON || path.resolve(process.cwd(), 'server', 'kb', 'index', 'clinical-guideline.meta.json');

export const DEFAULT_CHUNK_SIZE = Number(process.env.KB_CHUNK_SIZE || 900);
export const DEFAULT_CHUNK_OVERLAP = Number(process.env.KB_CHUNK_OVERLAP || 180);
export const DEFAULT_TOP_K = Number(process.env.KB_TOP_K || 4);
