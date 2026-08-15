/**
 * Unified RAG Data Ingestion Script.
 *
 * Scans the data/rag/ directory recursively, parses files of various formats
 * (Markdown, PDF, Word, TXT, JSON), chunks them, and ingests them into the
 * Chroma vector database collection `accessibility_knowledge`.
 *
 * Supported formats:
 * - .md: Parses frontmatter if present; falls back to filename/body.
 * - .txt: Reads raw text.
 * - .pdf: Extracts text using pdf-parse.
 * - .docx: Extracts text using mammoth.
 * - .json: Parses standard JSON array of knowledge entries or stringifies object.
 *
 * Run: npm run import:rag
 */

import "dotenv/config";
import fs from "fs";
import path from "path";
import pdf from "pdf-parse";
import mammoth from "mammoth";
import {
  ingestKnowledgeBatch,
  searchKnowledge,
} from "../modules/ai/knowledge.service";

const DATA_DIR = path.resolve(__dirname, "..", "..", "data", "rag");
const CHUNK_SIZE = 800;
const CHUNK_OVERLAP = 100;

interface DocumentPayload {
  id: string;
  title: string;
  content: string;
  source: string;
  category: string;
}

/** Recursively lists all supported files under a directory, ignoring graphify-out. */
function getFilesRecursively(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const files: string[] = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const resPath = path.join(dir, entry.name);
    // Ignore hidden files and graphify directories
    if (entry.name.startsWith(".") || entry.name === "graphify-out") {
      continue;
    }

    if (entry.isDirectory()) {
      files.push(...getFilesRecursively(resPath));
    } else {
      const ext = path.extname(entry.name).toLowerCase();
      if ([".md", ".txt", ".pdf", ".docx", ".json"].includes(ext)) {
        files.push(resPath);
      }
    }
  }
  return files;
}

/** CJK-safe text chunking with overlap */
function chunkText(text: string): string[] {
  if (text.length <= CHUNK_SIZE) return [text];

  const chunks: string[] = [];
  let start = 0;

  while (start < text.length) {
    let end = Math.min(start + CHUNK_SIZE, text.length);

    if (end < text.length) {
      const window = text.slice(start, end);
      const paraBreak = window.lastIndexOf("\n\n");
      const lineBreak = window.lastIndexOf("\n");
      if (paraBreak > CHUNK_SIZE * 0.5) {
        end = start + paraBreak;
      } else if (lineBreak > CHUNK_SIZE * 0.5) {
        end = start + lineBreak;
      }
    }

    const piece = text.slice(start, end).trim();
    if (piece) chunks.push(piece);

    if (end >= text.length) break;
    start = Math.max(end - CHUNK_OVERLAP, start + 1);
  }

  return chunks;
}

/** Parse frontmatter from raw markdown string */
function parseMarkdown(raw: string, filename: string): { title: string; category: string; source: string; body: string } {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) {
    return {
      title: path.basename(filename, ".md"),
      category: "00_general",
      source: "",
      body: raw.trim(),
    };
  }
  const [, front, rest] = match;

  const scalar = (key: string): string => {
    const m = front.match(new RegExp(`^${key}:\\s*(.*)$`, "m"));
    if (!m) return "";
    return m[1].trim().replace(/^"(.*)"$/, "$1");
  };

  const title = scalar("title") || path.basename(filename, ".md");
  const category = scalar("category") || "00_general";
  const source = scalar("url") || scalar("source") || "";
  let body = rest.replace(/^\s*#\s+.*\n+/, ""); // strip duplicate H1
  body = body.replace(/\n{3,}/g, "\n\n").trim();

  return { title, category, source, body };
}

/** Process a single file based on its extension */
async function processFile(filePath: string): Promise<DocumentPayload[]> {
  const ext = path.extname(filePath).toLowerCase();
  const fileIdBase = path.basename(filePath, ext);
  const relativePath = path.relative(DATA_DIR, filePath);
  const titleDefault = fileIdBase.replace(/[_-]/g, " ");

  try {
    if (ext === ".md") {
      const raw = fs.readFileSync(filePath, "utf-8");
      const { title, category, source, body } = parseMarkdown(raw, filePath);
      if (!body) return [];
      const chunks = chunkText(body);
      return chunks.map((chunk, idx) => ({
        id: `rag-md-${fileIdBase}-${idx}`,
        title: chunks.length > 1 ? `${title}｜第${idx + 1}段` : title,
        content: chunk,
        source: source || relativePath,
        category,
      }));
    }

    if (ext === ".txt") {
      const raw = fs.readFileSync(filePath, "utf-8").trim();
      if (!raw) return [];
      const chunks = chunkText(raw);
      return chunks.map((chunk, idx) => ({
        id: `rag-txt-${fileIdBase}-${idx}`,
        title: chunks.length > 1 ? `${titleDefault}｜第${idx + 1}段` : titleDefault,
        content: chunk,
        source: relativePath,
        category: "00_general",
      }));
    }

    if (ext === ".pdf") {
      const buffer = fs.readFileSync(filePath);
      const parsed = await (pdf as any)(buffer);
      const rawText = parsed.text.trim();
      if (!rawText) return [];
      const chunks = chunkText(rawText);
      return chunks.map((chunk, idx) => ({
        id: `rag-pdf-${fileIdBase}-${idx}`,
        title: chunks.length > 1 ? `${titleDefault}｜第${idx + 1}段` : titleDefault,
        content: chunk,
        source: relativePath,
        category: "00_general",
      }));
    }

    if (ext === ".docx") {
      const result = await mammoth.extractRawText({ path: filePath });
      const rawText = result.value.trim();
      if (!rawText) return [];
      const chunks = chunkText(rawText);
      return chunks.map((chunk, idx) => ({
        id: `rag-docx-${fileIdBase}-${idx}`,
        title: chunks.length > 1 ? `${titleDefault}｜第${idx + 1}段` : titleDefault,
        content: chunk,
        source: relativePath,
        category: "00_general",
      }));
    }

    if (ext === ".json") {
      const raw = fs.readFileSync(filePath, "utf-8").trim();
      if (!raw) return [];
      const parsed = JSON.parse(raw);

      // Format A: Array of KnowledgeEntries
      if (Array.isArray(parsed)) {
        const payloads: DocumentPayload[] = [];
        parsed.forEach((item, itemIdx) => {
          const content = item.content || item.body || JSON.stringify(item);
          const title = item.title || `${titleDefault} - Item ${itemIdx + 1}`;
          const chunks = chunkText(content);
          chunks.forEach((chunk, chunkIdx) => {
            payloads.push({
              id: `rag-json-${fileIdBase}-${itemIdx}-${chunkIdx}`,
              title: chunks.length > 1 ? `${title}｜第${chunkIdx + 1}段` : title,
              content: chunk,
              source: item.source || item.url || relativePath,
              category: item.category || "00_general",
            });
          });
        });
        return payloads;
      } else {
        // Format B: Single JSON Object
        const content = parsed.content || parsed.body || JSON.stringify(parsed, null, 2);
        const title = parsed.title || titleDefault;
        const chunks = chunkText(content);
        return chunks.map((chunk, idx) => ({
          id: `rag-json-${fileIdBase}-${idx}`,
          title: chunks.length > 1 ? `${title}｜第${idx + 1}段` : title,
          content: chunk,
          source: parsed.source || parsed.url || relativePath,
          category: parsed.category || "00_general",
        }));
      }
    }
  } catch (err) {
    console.error(`Error processing file ${relativePath}:`, err);
  }

  return [];
}

async function main() {
  if (!fs.existsSync(DATA_DIR)) {
    console.error(`Data directory not found: ${DATA_DIR}`);
    process.exit(1);
  }

  console.log(`Scanning directory: ${DATA_DIR}...`);
  const files = getFilesRecursively(DATA_DIR);
  if (files.length === 0) {
    console.warn(`No supported files found in ${DATA_DIR}.`);
    process.exit(0);
  }

  console.log(`Found ${files.length} supported file(s) for RAG ingestion.`);

  const allChunks: DocumentPayload[] = [];
  for (const file of files) {
    const relativePath = path.relative(DATA_DIR, file);
    console.log(`Processing: ${relativePath}`);
    const chunks = await processFile(file);
    if (chunks.length > 0) {
      allChunks.push(...chunks);
      console.log(`  -> Generated ${chunks.length} chunks.`);
    } else {
      console.log(`  -> No chunks generated (empty or failed).`);
    }
  }

  if (allChunks.length === 0) {
    console.log("No text content extracted. Ingestion aborted.");
    process.exit(0);
  }

  console.log(`\nIngesting ${allChunks.length} chunks into Chroma collection...`);
  try {
    await ingestKnowledgeBatch(allChunks);
    console.log("🟢 Ingestion completed successfully!");

    // Simple search test
    const query = "復康巴士";
    console.log(`\nRunning smoke test search for "${query}":`);
    const results = await searchKnowledge(query, 3);
    if (results.length === 0) {
      console.log("  No matches found (Chroma might be empty or search failed).");
    } else {
      results.forEach((r, idx) => {
        console.log(`  [${idx + 1}] [Score: ${r.score.toFixed(3)}] ${r.title} (${r.category})`);
        console.log(`      Source: ${r.source}`);
        console.log(`      Snippet: ${r.content.substring(0, 100).replace(/\n/g, " ")}...`);
      });
    }
  } catch (err: any) {
    console.error("🔴 Ingestion failed:", err.message || err);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
