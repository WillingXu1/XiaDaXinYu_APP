import fs from 'fs';
import readline from 'readline';
import { DEFAULT_TOP_K, KB_INDEX_JSONL, KB_META_JSON } from './constants.js';

const CJK_TOKEN_REGEX = /[\u4e00-\u9fa5a-zA-Z0-9]{2,}/g;

const unique = (arr) => [...new Set(arr)];

const splitChineseNGram = (term) => {
  if (!/[\u4e00-\u9fa5]/.test(term) || term.length <= 4) {
    return [term];
  }

  const grams = [];
  for (let i = 0; i < term.length - 1; i += 1) {
    grams.push(term.slice(i, i + 2));
  }
  return grams;
};

const extractTerms = (text = '') => {
  const baseTerms = text.match(CJK_TOKEN_REGEX) || [];
  const expanded = baseTerms.flatMap(splitChineseNGram);
  return unique(expanded).slice(0, 40);
};

const countOccurrences = (text, term) => {
  if (!term) return 0;
  let idx = 0;
  let count = 0;
  while (idx < text.length) {
    const found = text.indexOf(term, idx);
    if (found === -1) break;
    count += 1;
    idx = found + term.length;
  }
  return count;
};

const scoreChunk = (chunkText, terms) => {
  let score = 0;
  for (const term of terms) {
    const hit = countOccurrences(chunkText, term);
    if (hit > 0) {
      score += hit * Math.min(term.length, 6);
    }
  }

  if (chunkText.length > 1200) {
    score *= 0.92;
  }

  return score;
};

const ensureIndexExists = () => {
  if (!fs.existsSync(KB_INDEX_JSONL)) {
    return false;
  }
  return true;
};

export const getKbStatus = () => {
  const exists = ensureIndexExists();
  if (!exists) {
    return {
      ready: false,
      message: 'KB index file does not exist. Run: npm run kb:build'
    };
  }

  let meta = null;
  if (fs.existsSync(KB_META_JSON)) {
    try {
      meta = JSON.parse(fs.readFileSync(KB_META_JSON, 'utf8'));
    } catch (error) {
      meta = null;
    }
  }

  return {
    ready: true,
    message: 'KB is ready',
    meta,
    warning: meta?.warning || null
  };
};

export const searchClinicalGuideline = async ({ query, topK = DEFAULT_TOP_K }) => {
  if (!ensureIndexExists()) {
    return [];
  }

  const terms = extractTerms(query);
  if (!terms.length) {
    return [];
  }

  const stream = fs.createReadStream(KB_INDEX_JSONL, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  const best = [];

  for await (const line of rl) {
    if (!line.trim()) continue;

    let chunk;
    try {
      chunk = JSON.parse(line);
    } catch (error) {
      continue;
    }

    const content = String(chunk.content || '');
    const score = scoreChunk(content, terms);
    if (score <= 0) continue;

    const item = {
      id: chunk.id,
      page: chunk.page,
      source: chunk.source,
      content,
      score: Number(score.toFixed(2))
    };

    best.push(item);
    best.sort((a, b) => b.score - a.score);
    if (best.length > topK) {
      best.pop();
    }
  }

  return best;
};
