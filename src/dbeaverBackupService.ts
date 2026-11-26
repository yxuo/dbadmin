import * as fs from "fs/promises";
import * as path from "path";

export type DbeaverBackupFormat =
  | "custom"
  | "tar"
  | "directory"
  | "plain"
  | "unknown";

export interface DbeaverBackupClassification {
  format: DbeaverBackupFormat;
  path: string;
  isDirectory: boolean;
  detail: string;
}

export interface DbeaverDataEntry {
  id: string;
  tableName: string;
  line: string;
  /** Número de entradas do TOC relacionadas à tabela (estimativa de operações). */
  operationCount: number;
}

const CUSTOM_SIGNATURE = Buffer.from("PGDMP", "ascii");
const TAR_SIGNATURE_OFFSET = 257;
const TAR_SIGNATURE = Buffer.from("ustar", "ascii");
const SQL_SAMPLE_BYTES = 64 * 1024;

export async function classifyDbeaverBackup(
  filename: string,
): Promise<DbeaverBackupClassification> {
  const target = String(filename || "").trim();
  if (!target) {
    throw new Error("Informe o arquivo de backup.");
  }

  const stats = await fs.stat(target);
  if (stats.isDirectory()) {
    const tocPath = path.join(target, "toc.dat");
    try {
      const tocStats = await fs.stat(tocPath);
      if (tocStats.isFile()) {
        return {
          format: "directory",
          path: target,
          isDirectory: true,
          detail: "Dump PostgreSQL em formato Directory.",
        };
      }
    } catch {
      // Fall through with an explicit unsupported-format error.
    }

    return {
      format: "unknown",
      path: target,
      isDirectory: true,
      detail: "A pasta não contém toc.dat de um dump PostgreSQL Directory.",
    };
  }

  const handle = await fs.open(target, "r");
  try {
    const header = Buffer.alloc(Math.max(SQL_SAMPLE_BYTES, TAR_SIGNATURE_OFFSET + TAR_SIGNATURE.length));
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    const sample = header.subarray(0, bytesRead);

    if (sample.subarray(0, CUSTOM_SIGNATURE.length).equals(CUSTOM_SIGNATURE)) {
      return {
        format: "custom",
        path: target,
        isDirectory: false,
        detail: "Dump PostgreSQL Custom (PGDMP).",
      };
    }

    if (
      sample.length >= TAR_SIGNATURE_OFFSET + TAR_SIGNATURE.length &&
      sample
        .subarray(TAR_SIGNATURE_OFFSET, TAR_SIGNATURE_OFFSET + TAR_SIGNATURE.length)
        .equals(TAR_SIGNATURE)
    ) {
      return {
        format: "tar",
        path: target,
        isDirectory: false,
        detail: "Dump PostgreSQL em contêiner Tar.",
      };
    }

    const text = sample.toString("utf8").replace(/^\uFEFF/, "");
    if (isLikelyPlainSql(text, sample)) {
      return {
        format: "plain",
        path: target,
        isDirectory: false,
        detail: "Arquivo SQL textual.",
      };
    }

    return {
      format: "unknown",
      path: target,
      isDirectory: false,
      detail: `Formato de backup não reconhecido: ${path.basename(target)}.`,
    };
  } finally {
    await handle.close();
  }
}

export function parseDbeaverDataEntries(toc: string): DbeaverDataEntry[] {
  const lines = String(toc || "").split(/\r?\n/);
  const entries: DbeaverDataEntry[] = [];
  for (const rawLine of lines) {
    const idMatch = rawLine.match(/^\s*(\d+);/);
    const marker = rawLine.indexOf("TABLE DATA ");
    if (!idMatch || marker < 0) {
      continue;
    }
    const objectAndOwner = rawLine.slice(marker + "TABLE DATA ".length).trim();
    const tokens = objectAndOwner.split(/\s+/);
    tokens.pop();
    const tableName = tokens.join(" ").trim();
    if (!tableName) {
      continue;
    }
    // O TOC não possui quantidade de linhas. Contamos as entradas que
    // mencionam a mesma tabela para oferecer uma medida de complexidade
    // (dados, índices, constraints etc.), sem apresentar isso como row count.
    const normalizedTable = tableName.replace(/\s+/g, " ").trim();
    const operationCount = lines.filter((line) => {
      if (!/^\s*\d+;/.test(line) || line.indexOf(normalizedTable) < 0) {
        return false;
      }
      return /TABLE DATA |TABLE |INDEX |CONSTRAINT |TRIGGER |FK CONSTRAINT /i.test(line);
    }).length;
    entries.push({
      id: idMatch[1],
      tableName,
      line: rawLine,
      operationCount: Math.max(1, operationCount),
    });
  }
  return entries;
}

export function applyIgnoredDbeaverDataEntries(
  toc: string,
  ignoredIds: string[],
): string {
  const ignored = new Set(ignoredIds.map(String));
  return String(toc)
    .split(/\r?\n/)
    .map((line) => {
      const match = line.match(/^\s*(\d+);/);
      return match && ignored.has(match[1]) && line.indexOf("TABLE DATA ") >= 0
        ? `;${line}`
        : line;
    })
    .join("\n");
}

function isLikelyPlainSql(text: string, bytes: Buffer): boolean {
  if (bytes.includes(0)) {
    return false;
  }

  const trimmed = text.trimStart();
  if (!trimmed) {
    return false;
  }

  return /^(?:--|\/\*|#!|SET\b|CREATE\b|ALTER\b|INSERT\b|COPY\b|BEGIN\b|START\b|DO\b|DROP\b|GRANT\b|REVOKE\b|SELECT\b|COMMENT\b|TRUNCATE\b)/i.test(
    trimmed,
  );
}
