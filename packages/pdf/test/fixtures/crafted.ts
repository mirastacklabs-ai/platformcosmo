/**
 * Crafted hostile inputs from the C-2 review (S-Q01 … C-Q02). Each builds bytes in memory and
 * names the public API calls that exercise it; `crafted.test.ts` asserts time and memory
 * bounds for every case.
 */
import { zlibSync } from "fflate";
import { bytes, cat, flate, PdfWriter, imageDict } from "./gen.js";

const MiB = 1024 * 1024;

/** Concatenates a header, `n` repetitions of `unit`, and a tail, without big JS strings. */
function repeat(head: string, unit: string, n: number, tail = ""): Uint8Array {
  const h = bytes(head);
  const u = bytes(unit);
  const t = bytes(tail);
  const out = new Uint8Array(h.length + u.length * n + t.length);
  out.set(h, 0);
  for (let i = 0; i < n; i++) out.set(u, h.length + i * u.length);
  out.set(t, h.length + u.length * n);
  return out;
}

const fill = (n: number, c: number): Uint8Array => new Uint8Array(n).fill(c);

/** S-Q01: a 100k-entry table whose trailer's /XRefStm points back at the table itself. */
export function xrefStmSelf(entries = 100_000): Uint8Array {
  const w = new PdfWriter();
  w.obj(1, "<< /Type /Catalog /Pages 2 0 R >>");
  w.obj(2, "<< /Type /Pages /Kids [] /Count 0 >>");
  const at = w.length;
  const o1 = w.offsets.get(1) as number;
  const o2 = w.offsets.get(2) as number;
  const row = (n: number): string =>
    n === 1 || n === 2
      ? `${String(n === 1 ? o1 : o2).padStart(10, "0")} 00000 n \n`
      : "0000000000 65535 f \n";
  let s = `xref\n0 ${entries}\n`;
  for (let n = 0; n < entries; n++) s += row(n);
  w.raw(s);
  w.raw(`trailer\n<< /Size ${entries} /Root 1 0 R /XRefStm ${at} >>\nstartxref\n${at}\n%%EOF\n`);
  return w.bytes();
}

/** S-Q01: 70 distinct tables chained through /XRefStm. */
export function xrefStmChain(n = 70): Uint8Array {
  const w = new PdfWriter();
  w.obj(1, "<< /Type /Catalog /Pages 2 0 R >>");
  w.obj(2, "<< /Type /Pages /Kids [] /Count 0 >>");
  // tables are written last-first so each can point at the previous one written
  let next = -1;
  let first = -1;
  for (let i = 0; i < n; i++) {
    const at = w.length;
    w.raw(
      `xref\n1 2\n${String(w.offsets.get(1)).padStart(10, "0")} 00000 n \n${String(w.offsets.get(2)).padStart(10, "0")} 00000 n \n`,
    );
    w.raw(`trailer\n<< /Size 3 /Root 1 0 R${next >= 0 ? ` /XRefStm ${next}` : ""} >>\n`);
    next = at;
    first = at;
  }
  w.raw(`startxref\n${first}\n%%EOF\n`);
  return w.bytes();
}

/** S-Q02: an object stream whose 1000 entries all sit at offset 0, on a 400k-element array. */
export function objStmSameOffset(
  entries = 1000,
  elements = 400_000,
  body?: Uint8Array,
): Uint8Array {
  const w = new PdfWriter(null, "%PDF-1.5\n");
  w.obj(1, "<< /Type /Catalog /Pages 2 0 R >>");
  const kids = Array.from({ length: entries }, (_, i) => `${10 + i} 0 R`).join(" ");
  w.obj(2, `<< /Type /Pages /Kids [${kids}] /Count ${entries} >>`);
  let head = "";
  for (let i = 0; i < entries; i++) {
    head += `${10 + i} 0 `;
    w.inStm.set(10 + i, [5, i]);
  }
  const obj = body ?? repeat("[", "0 ", elements, "]");
  const data = cat(bytes(head), obj);
  w.obj(
    5,
    `<< /Type /ObjStm /N ${entries} /First ${head.length} /Filter /FlateDecode >>`,
    flate(data),
  );
  w.xrefStream(6, "/Root 1 0 R");
  return w.bytes();
}

/** S-Q02: the same with an unclosed literal string. */
export const objStmUnclosedString = (entries = 1000, len = 800_000): Uint8Array =>
  objStmSameOffset(entries, 0, cat(bytes("("), fill(len, 0x61)));

/** S-Q02: K plain `N 0 obj (` headers and no xref (repair parses each one). */
export function plainUnclosed(k = 20_000, filler = 1000): Uint8Array {
  const parts: Uint8Array[] = [
    bytes(
      "%PDF-1.7\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Kids [] /Count 0 >> endobj\n",
    ),
  ];
  for (let i = 0; i < k; i++) parts.push(bytes(`\n${10 + i} 0 obj (`), fill(filler, 0x61));
  return cat(...parts);
}

/** S-Q03: 1 MiB of `trailer` repeated after a file without startxref. */
export function trailerRun(size = MiB): Uint8Array {
  const base = bytes(
    "%PDF-1.7\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Kids [] /Count 0 >> endobj\n",
  );
  return cat(base, repeat("", "trailer", Math.floor(size / 7)));
}

/** S-Q04: `n` stream headers whose /Length all land in one whitespace run (no endstream). */
export function streamsIntoWhitespace(n = 250_000, ws = 4 * MiB): Uint8Array {
  const head =
    "%PDF-1.7\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Kids [] /Count 0 >> endobj\n";
  // fixed-width headers so every length is known up front
  const unit = (i: number, len: number): string =>
    `${String(10 + i).padStart(7, "0")} 0 obj<</Length ${String(len).padStart(9, "0")}>>stream\n`;
  const ulen = unit(0, 0).length;
  const out = new Uint8Array(head.length + n * ulen + ws);
  out.set(bytes(head), 0);
  const wsStart = head.length + n * ulen;
  for (let i = 0; i < n; i++) {
    const dataStart = head.length + (i + 1) * ulen;
    out.set(bytes(unit(i, wsStart - dataStart)), head.length + i * ulen);
  }
  out.fill(0x20, wsStart);
  return out;
}

/** S-Q04: inline images whose /L lands every one of them in one 32 MiB run of spaces. */
export function inlineLongL(n = 1000): Uint8Array {
  const content = cat(
    repeat("", "BI /W 1 /H 1 /CS /G /BPC 8 /L 1048576 ID x EI ", n),
    fill(32 * MiB, 0x20),
  );
  return onePageRaw(content);
}

function onePageRaw(
  content: Uint8Array,
  resources = "",
  extra: [number, string, Uint8Array?][] = [],
): Uint8Array {
  const w = new PdfWriter();
  w.obj(1, "<< /Type /Catalog /Pages 2 0 R >>");
  w.obj(2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
  w.obj(
    3,
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /Resources << ${resources} >> >>`,
  );
  w.obj(4, "<< >>", content);
  for (const [num, body, data] of extra) w.obj(num, body, data);
  w.xref("/Root 1 0 R");
  return w.bytes();
}

/** S-Q05: `pages` pages sharing one unfiltered content stream of `size` bytes. */
export function pagesSharedContent(pages = 100_000, size = 10 * MiB): Uint8Array {
  const w = new PdfWriter();
  w.obj(1, "<< /Type /Catalog /Pages 2 0 R >>");
  const kids = Array.from({ length: pages }, (_, i) => `${10 + i} 0 R`).join(" ");
  w.obj(2, `<< /Type /Pages /Kids [${kids}] /Count ${pages} /MediaBox [0 0 10 10] >>`);
  w.obj(3, "<< >>", cat(repeat("", "q Q ", 1000), fill(size - 4000, 0x20)));
  for (let i = 0; i < pages; i++) w.obj(10 + i, "<< /Type /Page /Parent 2 0 R /Contents 3 0 R >>");
  w.xref("/Root 1 0 R");
  return w.bytes();
}

/** C-Q01: `n` inline 4096×4096 gray images with one byte of data each. */
export const inlineHugeImages = (n = 200): Uint8Array =>
  onePageRaw(repeat("", "q BI /W 4096 /H 4096 /CS /G /BPC 8 ID x EI Q ", n));

/** C-Q01: `n` distinct 4096×4096 image XObjects with empty streams. */
export function emptyImageXObjects(n = 200): Uint8Array {
  const extra: [number, string, Uint8Array][] = [];
  let names = "";
  let content = "";
  for (let i = 0; i < n; i++) {
    extra.push([10 + i, imageDict(4096, 4096, "/DeviceGray", 8), new Uint8Array(0)]);
    names += `/I${i} ${10 + i} 0 R `;
    content += `/I${i} Do `;
  }
  return onePageRaw(bytes(content), `/XObject << ${names}>>`, extra);
}

const FONT = "/Font << /F1 9 0 R >>";
const FONT_OBJ: [number, string] = [
  9,
  "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
];

/** C-Q02: one `Tj` showing a 60 MB string. */
export const tjHuge = (len = 60_000_000): Uint8Array =>
  onePageRaw(cat(bytes("BT /F1 12 Tf ("), fill(len, 0x61), bytes(") Tj ET")), FONT, [FONT_OBJ]);

/** C-Q02: `(a) Tj` five million times. */
export const tjMany = (n = 5_000_000): Uint8Array =>
  onePageRaw(repeat("BT /F1 1 Tf ", "(a) Tj ", n, "ET"), FONT, [FONT_OBJ]);

/**
 * R-N1: `stms` object streams, each holding `perStm` arrays of `names` names, every array a
 * /Kids entry (a non-dictionary page-tree node): about 25 M parsed values in total.
 */
export function namesInKids(stms = 4, perStm = 16, names = 400_000): Uint8Array {
  const w = new PdfWriter(null, "%PDF-1.5\n");
  w.obj(1, "<< /Type /Catalog /Pages 2 0 R >>");
  const kids: string[] = [];
  const arr = repeat("[", "/a ", names, "]\n");
  let num = 100;
  for (let s = 0; s < stms; s++) {
    const stmNum = 10 + s;
    let head = "";
    const members: number[] = [];
    for (let k = 0; k < perStm; k++) {
      head += `${num} ${k * arr.length} `;
      w.inStm.set(num, [stmNum, k]);
      kids.push(`${num} 0 R`);
      members.push(num++);
    }
    const body = new Uint8Array(arr.length * perStm);
    for (let k = 0; k < perStm; k++) body.set(arr, k * arr.length);
    const data = cat(bytes(head), body);
    w.obj(
      stmNum,
      `<< /Type /ObjStm /N ${perStm} /First ${head.length} /Filter /FlateDecode >>`,
      zlibSync(data, { level: 1 }),
    );
  }
  w.obj(2, `<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${kids.length} >>`);
  w.xrefStream(3, "/Root 1 0 R");
  return w.bytes();
}

/** N01: `<01>` maps to 256 characters; a 256-code string shown `runs` times. */
export function toUnicodeExpansion(runs = 200_000): Uint8Array {
  const dst = "0041".repeat(256);
  const cmap = `1 begincodespacerange <00> <FF> endcodespacerange\n1 beginbfchar <01> <${dst}> endbfchar`;
  const show = cat(bytes("("), new Uint8Array(256).fill(1), bytes(") Tj "));
  const content = cat(bytes("BT /F1 1 Tf "), repeatBytes(show, runs), bytes("ET"));
  return onePageRaw(content, "/Font << /F1 9 0 R >>", [
    [9, "<< /Type /Font /Subtype /Type1 /ToUnicode 8 0 R >>"],
    [8, "<< >>", bytes(cmap)],
  ]);
}

/** R-N3: `tables` classic tables of `entries` free entries, chained through /XRefStm. */
export function chainedTables(tables = 60, entries = 40_000): Uint8Array {
  const w = new PdfWriter();
  w.obj(1, "<< /Type /Catalog /Pages 2 0 R >>");
  w.obj(2, "<< /Type /Pages /Kids [] /Count 0 >>");
  const rows = "0000000000 65535 f \n".repeat(entries);
  let next = -1;
  for (let i = 0; i < tables; i++) {
    const at = w.length;
    w.raw(
      `xref\n3 ${entries}\n${rows}trailer\n<< /Size ${entries + 3}${next >= 0 ? ` /XRefStm ${next}` : ""} >>\n`,
    );
    next = at;
  }
  const top = w.length;
  w.raw(
    `xref\n1 2\n${String(w.offsets.get(1)).padStart(10, "0")} 00000 n \n${String(w.offsets.get(2)).padStart(10, "0")} 00000 n \n`,
  );
  w.raw(`trailer\n<< /Size 3 /Root 1 0 R /XRefStm ${next} >>\nstartxref\n${top}\n%%EOF\n`);
  return w.bytes();
}

function repeatBytes(unit: Uint8Array, n: number): Uint8Array {
  const out = new Uint8Array(unit.length * n);
  for (let i = 0; i < n; i++) out.set(unit, i * unit.length);
  return out;
}

export interface CraftedCase {
  readonly name: string;
  readonly review: string;
  readonly build: () => Uint8Array;
  /** Which API walk exercises the input. */
  readonly walk: "open" | "list" | "list-all-pages" | "text";
}

export const CASES: CraftedCase[] = [
  { name: "xrefstm-self-100k", review: "S-Q01", build: () => xrefStmSelf(), walk: "open" },
  { name: "xrefstm-chain-70", review: "S-Q01", build: () => xrefStmChain(), walk: "open" },
  {
    name: "objstm-1000-at-0-array-400k",
    review: "S-Q02",
    build: () => objStmSameOffset(),
    walk: "open",
  },
  {
    name: "objstm-1000-at-0-unclosed-string",
    review: "S-Q02",
    build: () => objStmUnclosedString(),
    walk: "open",
  },
  {
    name: "plain-20000-unclosed-strings",
    review: "S-Q02",
    build: () => plainUnclosed(),
    walk: "open",
  },
  { name: "trailer-1MiB", review: "S-Q03", build: () => trailerRun(), walk: "open" },
  {
    name: "streams-250k-into-whitespace",
    review: "S-Q04",
    build: () => streamsIntoWhitespace(),
    walk: "open",
  },
  {
    name: "inline-L-1MiB-into-32MiB-spaces-x1000",
    review: "S-Q04",
    build: () => inlineLongL(),
    walk: "list",
  },
  {
    name: "pages-100k-shared-10MB",
    review: "S-Q05",
    build: () => pagesSharedContent(),
    walk: "list-all-pages",
  },
  { name: "inline-4096sq-x200", review: "C-Q01", build: () => inlineHugeImages(), walk: "list" },
  {
    name: "empty-xobject-4096sq-x200",
    review: "C-Q01",
    build: () => emptyImageXObjects(),
    walk: "list",
  },
  { name: "tj-60MB", review: "C-Q02", build: () => tjHuge(), walk: "text" },
  { name: "tj-5M", review: "C-Q02", build: () => tjMany(), walk: "text" },
  { name: "names-25M-in-kids", review: "R-N1", build: () => namesInKids(), walk: "open" },
  {
    name: "tounicode-256x-200k-runs",
    review: "N01",
    build: () => toUnicodeExpansion(),
    walk: "text",
  },
  { name: "xrefstm-60-tables-x40k", review: "R-N3", build: () => chainedTables(), walk: "open" },
];
