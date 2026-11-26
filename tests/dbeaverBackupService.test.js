const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { classifyDbeaverBackup } = require("../out/dbeaverBackupService");
const {
  parseDbeaverDataEntries,
  applyIgnoredDbeaverDataEntries,
} = require("../out/dbeaverBackupService");
const {
  buildPgRestoreSqlArgs,
  normalizePgRestoreSql,
} = require("../out/dbeaverSqlConverter");

test("classifies PostgreSQL custom, tar, plain and directory dumps", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dbadmin-dbeaver-"));
  try {
    const custom = path.join(root, "sample.backup");
    await fs.writeFile(custom, Buffer.from("PGDMP\0rest"));
    assert.equal((await classifyDbeaverBackup(custom)).format, "custom");

    const tar = path.join(root, "sample.tar");
    const tarHeader = Buffer.alloc(512);
    tarHeader.write("ustar", 257, "ascii");
    await fs.writeFile(tar, tarHeader);
    assert.equal((await classifyDbeaverBackup(tar)).format, "tar");

    const sql = path.join(root, "sample.sql");
    await fs.writeFile(sql, "-- PostgreSQL dump\nCREATE TABLE test (id integer);");
    assert.equal((await classifyDbeaverBackup(sql)).format, "plain");

    const directory = path.join(root, "sample");
    await fs.mkdir(directory);
    await fs.writeFile(path.join(directory, "toc.dat"), "toc");
    assert.equal((await classifyDbeaverBackup(directory)).format, "directory");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("comments only selected TABLE DATA entries in the pg_restore list", () => {
  const toc = [
    "1; 0 10 TABLE public.apilog owner",
    "2; 0 11 TABLE DATA public.apilog owner",
    "3; 0 12 TABLE DATA public.core_user owner",
  ].join("\n");
  const entries = parseDbeaverDataEntries(toc);
  assert.deepEqual(entries.map((entry) => entry.tableName), [
    "public.apilog",
    "public.core_user",
  ]);
  const filtered = applyIgnoredDbeaverDataEntries(toc, [entries[0].id]);
  assert.match(filtered, /^;2; 0 11 TABLE DATA public\.apilog owner$/m);
  assert.match(filtered, /^3; 0 12 TABLE DATA public\.core_user owner$/m);
});

test("normalizes COPY data and removes unsupported psql commands", () => {
  const sql = [
    "SET transaction_timeout = 0;",
    "\\restrict abc",
    "CREATE TABLE public.users (id integer, name text);",
    "COPY public.users (id, name) FROM stdin;",
    "1\tAlice",
    "2\tBob's account",
    "\\.",
    "COPY public.files (id, content) FROM stdin;",
    "1\t\\xDEADBEEF",
    "\\.",
    "\\unrestrict abc",
  ].join("\n");

  const normalized = normalizePgRestoreSql(sql);
  assert.match(
    normalized,
    /INSERT INTO public\.users \(id, name\) VALUES \('1', 'Alice'\);/,
  );
  assert.match(
    normalized,
    /INSERT INTO public\.users \(id, name\) VALUES \('2', 'Bob''s account'\);/,
  );
  assert.match(
    normalized,
    /INSERT INTO public\.files \(id, content\) VALUES \('1', E'\\\\xDEADBEEF'\);/,
  );
  assert.doesNotMatch(normalized, /COPY|transaction_timeout|\\restrict|\\unrestrict/);
});

test("builds pg_restore conversion arguments without unsupported --inserts", () => {
  const args = buildPgRestoreSqlArgs({
    filename: "source.backup",
    format: "custom",
    schemaName: "public",
    outputFilename: "target.sql",
    sections: ["pre-data", "data", "post-data"],
    onlyData: false,
    onlySchema: false,
    includeIfExists: true,
    disableTriggers: false,
    verbose: false,
  });

  assert.ok(args.includes("--no-owner"));
  assert.ok(args.includes("--no-privileges"));
  assert.ok(args.includes("--file"));
  assert.ok(!args.includes("--inserts"));
  assert.ok(!args.includes("--column-inserts"));
});

test("converts the local DBeaver backup when the fixture and pg_restore exist", async (t) => {
  const sourceCandidates = [
    "C:\\Users\\Rapha\\Downloads\\2026-11-13.backup",
    "C:\\Users\\Rapha\\Downloads\\2026-11-13.backups",
  ];
  const source = sourceCandidates.find((candidate) => require("node:fs").existsSync(candidate));
  const binaryCandidates = [
    "C:\\Program Files\\PostgreSQL\\18\\bin\\pg_restore.exe",
    "C:\\Program Files\\PostgreSQL\\17\\bin\\pg_restore.exe",
    "C:\\Program Files\\pgAdmin 4\\runtime\\pg_restore.exe",
  ];
  const binary = binaryCandidates.find((candidate) => require("node:fs").existsSync(candidate));

  if (!source || !binary) {
    t.skip("Backup fixture or pg_restore.exe is not available on this machine.");
    return;
  }

  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dbadmin-dbeaver-convert-"));
  const rawSql = path.join(root, "raw.sql");
  try {
    const args = buildPgRestoreSqlArgs({
      filename: source,
      format: "custom",
      schemaName: "public",
      outputFilename: rawSql,
      sections: [],
      onlyData: false,
      onlySchema: false,
      includeIfExists: false,
      disableTriggers: false,
      verbose: false,
    });
    await new Promise((resolve, reject) => {
      const child = require("node:child_process").spawn(binary, args, {
        windowsHide: true,
      });
      let stderr = "";
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });
      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`pg_restore exited with ${code}: ${stderr}`));
      });
    });

    const normalized = normalizePgRestoreSql(await fs.readFile(rawSql, "utf8"));
    assert.doesNotMatch(normalized, /^\s*COPY\b/im);
    assert.doesNotMatch(normalized, /^\s*\\/m);
    assert.doesNotMatch(normalized, /^\s*SET\s+transaction_timeout/im);
    assert.match(normalized, /^\s*(?:--|SET|CREATE|ALTER|INSERT|SELECT|BEGIN|COMMIT)/m);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
