/** Regression tests for the remaining C-2 review findings (one `describe` per finding). */
import { describe, expect, it } from "vitest";
import { Decryptor, setupSecurity } from "../src/crypt.js";
import { filterList } from "../src/filters.js";
import { openPdf } from "../src/index.js";
import { isJpeg } from "../src/images.js";
import { PdfDict, PdfName, PdfString, type PdfValue } from "../src/objects.js";
import { codes, findDiag, latin1Of, mustOpen, timed } from "./helpers.js";
import * as g from "./fixtures/gen.js";

const IMG = "/XObject << /Im1 10 0 R >>";
const one: [number, string, Uint8Array][] = [
  [10, g.imageDict(1, 1, "/DeviceGray", 8), Uint8Array.from([7])],
];

describe("S-Q02 object-stream members are parsed within their slice", () => {
  it("an unclosed array in one member does not swallow the next", () => {
    const w = new g.PdfWriter(null, "%PDF-1.5\n");
    w.obj(1, "<< /Type /Catalog /Pages 2 0 R >>");
    w.objStm(5, [
      [2, "<< /Type /Pages /Kids [] /Count 0 >>"],
      [10, "[1 2"],
      [11, "(ok)"],
    ]);
    w.xrefStream(6, "/Root 1 0 R");
    const doc = mustOpen(w.bytes());
    expect(doc.file.loadObject(10)).toEqual([1, 2]);
    const s = doc.file.loadObject(11);
    expect(s).toBeInstanceOf(PdfString);
    expect(String.fromCharCode(...(s as PdfString).bytes)).toBe("ok");
  });
});

describe("S-Q08 filter lists, failure cache, per-form warnings", () => {
  it("builds at most maxFilters + 1 entries from a huge /Filter array", () => {
    const arr: PdfValue[] = Array.from({ length: 200_000 }, () => new PdfName("FlateDecode"));
    const t = performance.now();
    expect(filterList(arr, undefined, (v) => v)).toHaveLength(5);
    expect(performance.now() - t).toBeLessThan(100);
  });

  it("a failing form drawn 10k times is decoded once and reported once", () => {
    const pdf = g.onePage("/Fm Do ".repeat(10_000), "/XObject << /Fm 10 0 R >>", [
      [
        10,
        "<< /Type /XObject /Subtype /Form /BBox [0 0 1 1] /Filter /JBIG2Decode >>",
        g.bytes("x"),
      ],
    ]);
    const list = timed(2000, () => mustOpen(pdf).listImages(1));
    expect(codes(list.diagnostics).filter((c) => c === "pdf/unsupported-filter")).toHaveLength(1);
  });
});

describe("S-Q09 repair skips stream data", () => {
  it("a damaged file never adopts the objects of an unfiltered embedded PDF", () => {
    // the attachment is a whole PDF with five pages, written last (its definitions are newest)
    const inner = g.onePage("", "", [], { pageExtra: "/MediaBox [0 0 999 999]" });
    const w = new g.PdfWriter();
    w.obj(
      1,
      "<< /Type /Catalog /Pages 2 0 R /Names << /EmbeddedFiles << /Names [(a.pdf) 5 0 R] >> >> >>",
    );
    w.obj(2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
    w.obj(3, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R >>");
    w.obj(4, "<< >>", g.bytes(""));
    w.obj(5, "<< /Type /Filespec /F (a.pdf) /EF << /F 6 0 R >> >>");
    w.obj(6, "<< /Type /EmbeddedFile >>", inner);
    w.xref("/Root 1 0 R", { startxref: 3 }); // damaged: forces the repair scan
    const r = openPdf(w.bytes());
    expect(r.ok).toBe(true);
    findDiag(r.diagnostics, "pdf/xref-repaired", "info");
    const info = (r as { doc: ReturnType<typeof mustOpen> }).doc.info();
    expect(info.pageCount).toBe(1);
    expect(info.pages[0]?.mediaBox).toEqual([0, 0, 300, 200]);
  });
});

describe("S-Q11 placements per page", () => {
  it("stops listing at the cap with pdf/too-complex", () => {
    const doc = mustOpen(g.onePage("/Im1 Do ".repeat(50), IMG, one), {
      limits: { maxPlacements: 10 },
    });
    const list = doc.listImages(1, { hash: false });
    expect(list.images).toHaveLength(10);
    findDiag(list.diagnostics, "pdf/too-complex", "warning");
  });
});

describe("S-Q12 form self-check on the resolved object", () => {
  it("a form reached through a reference chain to itself is one form", () => {
    const pdf = g.onePage("/Fm Do", "/XObject << /Fm 10 0 R >>", [
      [
        10,
        "<< /Type /XObject /Subtype /Form /BBox [0 0 1 1] /Resources << /XObject << /A 11 0 R /Im1 12 0 R >> >> >>",
        g.bytes("/Im1 Do /A Do"),
      ],
      [11, "10 0 R"],
      [12, g.imageDict(1, 1, "/DeviceGray", 8), Uint8Array.from([1])],
    ]);
    const list = mustOpen(pdf).listImages(1, { hash: false });
    expect(list.images).toHaveLength(1); // not 16 nested copies
    expect(findDiag(list.diagnostics, "pdf/too-complex", "warning").message).toMatch(
      /draws itself/,
    );
  });
});

describe("S-Q13 operands", () => {
  it("keep the last operands without shifting, and count toward the cap", () => {
    const lead = "1 ".repeat(1000);
    const doc = mustOpen(g.onePage(`q ${lead}20 0 0 10 5 5 cm /Im1 Do Q`, IMG, one));
    expect(doc.listImages(1, { hash: false }).images[0]?.bbox).toEqual({
      x: 5,
      y: 185,
      w: 20,
      h: 10,
    });
    const capped = mustOpen(g.onePage(`${lead}/Im1 Do`, IMG, one), {
      limits: { maxOpsPerPage: 500 },
    });
    findDiag(capped.listImages(1).diagnostics, "pdf/too-complex", "error");
  });
});

describe("S-Q15 repair records generations; huge subsection counts repair", () => {
  it("keeps the scanned generation", () => {
    const pdf = g.bytes(
      "%PDF-1.7\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Kids [] /Count 0 >> endobj\n5 3 obj (gen three) endobj\n",
    );
    const doc = mustOpen(pdf);
    expect(doc.file.entries.get(5)?.gen).toBe(3);
  });

  it("a subsection count above maxObjects is repaired, not refused", () => {
    const s = String.fromCharCode(...g.rasterPdf());
    const r = openPdf(g.bytes(s.replace(/\nxref\n0 \d+/, "\nxref\n0 400000000")));
    expect(r.ok).toBe(true);
    findDiag(r.diagnostics, "pdf/xref-repaired", "info");
  });
});

describe("S-Q16 allowlist under aliasing", () => {
  it("/Resources pointing at the catalog follows nothing new", () => {
    const pdf = g.onePage("/OpenAction Do /Names Do /AcroForm 12 Tf (x) Tj", "", [], {
      catalogExtra: "/OpenAction 20 0 R /Names 22 0 R /AcroForm 27 0 R",
      pageExtra: "",
    });
    const s = String.fromCharCode(...pdf).replace("/Resources <<  >>", "/Resources 1 0 R");
    const doc = mustOpen(g.bytes(s));
    doc.listImages(1);
    doc.text(1);
    expect([...doc.file.loaded].sort((a, b) => a - b)).toEqual([1, 2, 3, 4]);
  });

  it("/XObject aliased to a filespec's /EF dictionary loads no embedded file", () => {
    const pdf = latin1Of(g.activeContentPdf()).replace(
      "/Resources << /XObject << /Im1 10 0 R >> >>",
      "/Resources << /XObject 23 0 R /Font 27 0 R >>",
    );
    const fixed = g.bytes(
      pdf.replace(
        "q 10 0 0 10 0 0 cm /Im1 Do Q",
        "/EF Do /F Do /AcroForm 12 Tf /Fields 9 Tf (x) Tj",
      ),
    );
    const doc = mustOpen(fixed);
    doc.listImages(1);
    doc.text(1);
    const loaded = [...doc.file.loaded].sort((a, b) => a - b);
    // 23 (the filespec) and 27 (AcroForm) are reached through allowed keys; nothing they
    // point at is: not the embedded file (24), the XFA (28), the bomb (21) or the actions
    expect(loaded).toEqual([1, 2, 3, 4, 23, 27]);
  });
});

describe("C-Q04 security handler consistency", () => {
  const enc = (extra: Record<string, PdfValue>): PdfDict => {
    const d = new PdfDict();
    d.map.set("Filter", new PdfName("Standard"));
    d.map.set("O", new PdfString(new Uint8Array(48)));
    d.map.set("U", new PdfString(new Uint8Array(48)));
    d.map.set("UE", new PdfString(new Uint8Array(32)));
    d.map.set("P", -4);
    for (const [k, v] of Object.entries(extra)) d.map.set(k, v);
    return d;
  };
  const cf = (cfm: string): PdfDict => {
    const std = new PdfDict();
    std.map.set("CFM", new PdfName(cfm));
    const d = new PdfDict();
    d.map.set("StdCF", std);
    return d;
  };
  const filt = { StmF: new PdfName("StdCF"), StrF: new PdfName("StdCF") };
  // the reason is asserted: these inputs would also fail the /U check without the fix (N02)
  it.each([
    ["AESV3 under V4", { V: 4, R: 4, CF: cf("AESV3"), ...filt }, /not allowed with V4/],
    ["AESV2 under V5", { V: 5, R: 6, CF: cf("AESV2"), ...filt }, /not allowed with V5/],
    ["RC4 under V5", { V: 5, R: 6, CF: cf("V2"), ...filt }, /not allowed with V5/],
    ["a /Length of 129 bits", { V: 2, R: 3, Length: 129 }, /multiple of 8/],
    ["a /Length of 300 bits", { V: 2, R: 3, Length: 300 }, /multiple of 8/],
    ["a 256-bit RC4 key", { V: 2, R: 3, Length: 256 }, /longer than 128/],
  ])("refuses %s", (_, extra, reason) => {
    const s = setupSecurity(enc(extra as Record<string, PdfValue>), new Uint8Array(16), (v) => v);
    expect(s.ok).toBe(false);
    expect((s as { reason: string }).reason).toMatch(reason as RegExp);
  });
});

/**
 * qpdf 11.3.0 known-answer vectors (Debian bookworm package), each from
 * `qpdf --allow-weak-crypto --object-streams=disable --compress-streams=n --encrypt "" ownerpw
 * <256 [--force-R5] | 128 --use-aes=y|n> -- in.pdf out.pdf` on a file whose /Info (object 2 0)
 * holds `/Producer (qpdf known-answer vector)`; the key is `qpdf --show-encryption-key`. The R2
 * vector came from `qpdf --empty --allow-weak-crypto --encrypt "" ownerpw 40 -- out.pdf`.
 */
interface Kat {
  readonly name: string;
  readonly V: number;
  readonly R: number;
  readonly length: number;
  readonly P: number;
  readonly O: string;
  readonly U: string;
  readonly UE?: string;
  readonly ID: string;
  readonly cfm?: string;
  readonly key: string;
  /** The encrypted `/Producer` string of object 2 0 in the same qpdf file. */
  readonly str?: string;
}
const KAT: Kat[] = [
  {
    name: "R6 AES-256 (algorithm 2.B)",
    V: 5,
    R: 6,
    length: 256,
    P: -4,
    cfm: "AESV3",
    ID: "c856c3c2c831142abda7ed4d7cd4901e",
    O: "7ef96f9022a184dca42a784889886307c9c0376c0e81832706c998b98549f10093067cbbbbbe526a075aa75b40bdfc98",
    U: "607a0a19bd3bb77096c5543876f86bcf53dd1626981af595225343860cc8d8f01d97f01bb2f9c387472b71ae77516a7a",
    UE: "9ba67d334f1818a5a3d5d8b96b625f384d931e4a3978fced5afa37c364f908fb",
    key: "ab266526fcf13f5f512f1811435ce5bff178d7808d807c2179ba50a1c79e26ca",
    str: "05386472bcb997a5b4d03fdd1ff62a5951beb21c80a7f15426e1b240ce2f96096d679f50a7fb1b690df2758c69a8b695",
  },
  {
    name: "R5 AES-256 (--force-R5)",
    V: 5,
    R: 5,
    length: 256,
    P: -4,
    cfm: "AESV3",
    ID: "3329bf9074610096dfaf07d04ad5a85b",
    O: "45a42f3f1e56161c08a2f1b9e771c46fc19fc3a0e4e9e1e9abd80c48450c7c75781771528363e3444f27ca4953e8c768",
    U: "0ce8e2d7edf10029ec9275e9a92144703da3a1620b4fc373245928b9701cde65c2aa6b8758c94e70cd384fd670d66fce",
    UE: "b2b04b752bd75aa7d8bfa0dac1052d606b651dc4473b7f34a6f814b050aaa32a",
    key: "ff62315eb36f2e3011b8eba88ebd73a64a991eb806425316665afcf12b0700a4",
    str: "3a03dc384a96169d978ad8bced20e2ffabea4c8f71709b004bf23b3a2e5b268950e371fd7ef913633b5d959630a8a894",
  },
  {
    name: "R4 AES-128 (AESV2, sAlT)",
    V: 4,
    R: 4,
    length: 128,
    P: -4,
    cfm: "AESV2",
    ID: "733ed59fa5295590dfa57f233e9a4a61",
    O: "5a0c0b55deda723d6a1a77ca020e0bf91273d02733c4748c700d9eb9a6d68a09",
    U: "ce79ecf7304e5d5d696395f3f97c75510122456a91bae5134273a6db134c87c4",
    key: "1d70281ffe9270928d70fec8afe7c805",
    str: "1516a1e747ebaa4869e532b97c3f96abb0d062c5db1dc31378ed3a296f7659119c8c57d138e40805c93f7fa37f83e6a1",
  },
  {
    name: "R3 RC4-128",
    V: 2,
    R: 3,
    length: 128,
    P: -4,
    ID: "f8cb9c455d5a2028d6bc64981f84585a",
    O: "5a0c0b55deda723d6a1a77ca020e0bf91273d02733c4748c700d9eb9a6d68a09",
    U: "9fadb28349e18669ee8b1dfaba7420b30122456a91bae5134273a6db134c87c4",
    key: "40b28c0cf19ae428f800fcb5f9c70813",
    str: "339a1b79ea67e356e9b6518b30bf8f20206472a560c92052",
  },
  {
    name: "R2 RC4-40",
    V: 1,
    R: 2,
    length: 40,
    P: -4,
    ID: "9be3b7884af522fd22b6343b32bfa991",
    O: "a0b130ed69fe55902dc33d8c602379c856fe7ed15e9d8e0bacd7367a5f67b6dc",
    U: "a56c018888f5ca763a2346bb7cf51cf7020a42d8cd6635555636e3c1ac08515c",
    key: "de7c05d4e8",
  },
];

describe("C-Q07 external known-answer vectors (written by qpdf 11, not by us)", () => {
  // Values from files encrypted by `qpdf --encrypt "" owner <bits>` in a throwaway container;
  // the expected file key is qpdf's own `--show-encryption-key` output.
  const hexb = (h: string): Uint8Array =>
    Uint8Array.from(h.match(/../g) as string[], (x) => parseInt(x, 16));
  const dict = (e: Record<string, PdfValue>): PdfDict => {
    const d = new PdfDict();
    for (const [k, v] of Object.entries(e)) d.map.set(k, v);
    return d;
  };
  const str = (h: string): PdfString => new PdfString(hexb(h));
  it.each(KAT)("$name: derives qpdf's file key from /O /U /P /ID", (v) => {
    const cfd = new PdfDict();
    if (v.cfm) {
      const std = new PdfDict();
      std.map.set("CFM", new PdfName(v.cfm));
      std.map.set("Length", v.cfm === "AESV3" ? 32 : 16);
      cfd.map.set("StdCF", std);
    }
    const e = dict({
      Filter: new PdfName("Standard"),
      V: v.V,
      R: v.R,
      Length: v.length,
      P: v.P,
      O: str(v.O),
      U: str(v.U),
      ...(v.UE ? { UE: str(v.UE) } : {}),
      ...(v.cfm ? { CF: cfd, StmF: new PdfName("StdCF"), StrF: new PdfName("StdCF") } : {}),
    });
    const s = setupSecurity(e, hexb(v.ID), (x) => x);
    expect(s.ok).toBe(true);
    const dec = (s as { decryptor: Decryptor }).decryptor;
    expect(g.hex(dec.key)).toBe(v.key);
    if (v.str) {
      // our per-object key (RC4, or AES with sAlT / the IV prefix) on qpdf's ciphertext
      const plain = dec.decrypt(hexb(v.str), 2, 0, "string");
      expect(String.fromCharCode(...plain)).toBe("qpdf known-answer vector");
    }
  });

  it("refuses a real R4 vector whose crypt filter is swapped to AESV3 (N02)", () => {
    const v = KAT[2] as Kat;
    const std = new PdfDict();
    std.map.set("CFM", new PdfName("AESV3"));
    const cfd = new PdfDict();
    cfd.map.set("StdCF", std);
    const e = dict({
      Filter: new PdfName("Standard"),
      V: 4,
      R: 4,
      Length: 128,
      P: v.P,
      O: str(v.O),
      U: str(v.U),
      CF: cfd,
      StmF: new PdfName("StdCF"),
      StrF: new PdfName("StdCF"),
    });
    const s = setupSecurity(e, hexb(v.ID), (x) => x);
    expect(s.ok).toBe(false);
    expect((s as { reason: string }).reason).toMatch(/not allowed with V4/);
  });
});

describe("C-Q07 malformed AES payloads and Identity crypt filters", () => {
  const key = new Uint8Array(32).fill(7);
  const d = new Decryptor(key, "aesv3", "aesv3");
  it("short, ragged and badly padded payloads never throw", () => {
    expect(d.decrypt(new Uint8Array(31), 1, 0, "stream")).toHaveLength(0);
    expect(d.decrypt(new Uint8Array(16 + 20), 1, 0, "stream").length).toBeLessThanOrEqual(16);
    const out = d.decrypt(new Uint8Array(48).fill(3), 1, 0, "string"); // bad padding: kept
    expect(out.length).toBeGreaterThan(0);
  });

  it("/StmF /Identity leaves streams alone while strings are decrypted", () => {
    const sec = new g.Security({ kind: "aes-128" });
    const w = new g.PdfWriter(sec);
    w.obj(1, "<< /Type /Catalog /Pages 2 0 R >>");
    w.obj(2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
    w.obj(
      3,
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 10 10] /Contents 4 0 R /Resources << /XObject << /Im1 5 0 R >> >> >>",
    );
    w.obj(4, "<< >>", g.bytes("q 10 0 0 10 0 0 cm /Im1 Do Q"), { plainData: true });
    w.obj(
      5,
      (s) =>
        `<< /Type /XObject /Subtype /Image /Width 2 /Height 1 /ColorSpace [/Indexed /DeviceRGB 1 ${s(Uint8Array.from([1, 2, 3, 4, 5, 6]))}] /BitsPerComponent 8 >>`,
      Uint8Array.from([1, 0]),
      { plainData: true },
    );
    w.obj(99, sec.dict.replace("/StmF /StdCF", "/StmF /Identity"), undefined, { plain: true });
    w.xref(`/Root 1 0 R /Encrypt 99 0 R /ID [<${g.hex(g.FILE_ID)}> <${g.hex(g.FILE_ID)}>]`);
    const doc = mustOpen(w.bytes());
    expect(doc.info().encryption?.streams).toBe("none");
    const e = doc.extractImage(1, 0);
    expect(e.ok).toBe(true);
    expect(doc.listImages(1).images[0]?.colourSpace).toBe("Indexed(DeviceRGB)");
  });

  it("a stream with an Identity /Crypt filter is not decrypted (C-Q11)", () => {
    const sec = new g.Security({ kind: "rc4-128" });
    const w = new g.PdfWriter(sec);
    w.obj(1, "<< /Type /Catalog /Pages 2 0 R >>");
    w.obj(2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
    w.obj(
      3,
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 10 10] /Contents 4 0 R /Resources << /XObject << /Im1 5 0 R >> >> >>",
    );
    w.obj(4, "<< /Filter [/Crypt] >>", g.bytes("q 10 0 0 10 0 0 cm /Im1 Do Q"), {
      plainData: true,
    });
    w.obj(5, g.imageDict(1, 1, "/DeviceGray", 8), Uint8Array.from([9]));
    w.obj(99, sec.dict, undefined, { plain: true });
    w.xref(`/Root 1 0 R /Encrypt 99 0 R /ID [<${g.hex(g.FILE_ID)}> <${g.hex(g.FILE_ID)}>]`);
    const list = mustOpen(w.bytes()).listImages(1);
    expect(list.images).toHaveLength(1);
  });
});

describe("C-Q03 decryption is charged to the budget", () => {
  it("the same walk costs more decoded bytes encrypted than plain, by the decrypted bytes", () => {
    const plain = mustOpen(g.rasterPdf());
    const enc = mustOpen(g.encryptedPdf({ kind: "rc4-128" }));
    for (const d of [plain, enc]) d.listImages(1, { hash: false });
    const extra = enc.file.budget.decoded - plain.file.budget.decoded;
    // RC4 keeps lengths: the content stream (and the forms it draws) decrypted once each
    expect(extra).toBeGreaterThan(0);
    expect(extra).toBeLessThan(g.encryptedPdf({ kind: "rc4-128" }).length);
    // and it is enforced: a total below the plain walk plus the decryption fails
    const tight = mustOpen(g.encryptedPdf({ kind: "rc4-128" }), {
      limits: { maxTotalDecoded: plain.file.budget.decoded },
    });
    expect(codes(tight.listImages(1, { hash: false }).diagnostics)).toContain("pdf/too-large");
  });
});

describe("C-Q05 text runs hold no control or bidi characters", () => {
  const page = (codes: string): Uint8Array =>
    g.onePage(`BT /F 10 Tf <${codes}> Tj ET`, "/Font << /F 10 0 R >>", [
      [10, "<< /Type /Font /Subtype /Type0 /Encoding /Identity-H /ToUnicode 11 0 R >>"],
      [
        11,
        "<< >>",
        g.bytes(
          "1 beginbfchar <0001> <0007> <0002> <202E> <0003> <0085> <0004> <0041> <0005> <2028> <0006> <2029> <0007> <FEFF> endbfchar",
        ),
      ],
    ]);
  it("replaces C0, C1 and bidi controls with U+FFFD", () => {
    expect(mustOpen(page("0001000200030004")).text(1).runs[0]?.text).toBe("\uFFFD\uFFFD\uFFFDA");
  });
  it("replaces U+2028, U+2029 and U+FEFF too (N06)", () => {
    expect(mustOpen(page("0005000600070004")).text(1).runs[0]?.text).toBe("\uFFFD\uFFFD\uFFFDA");
  });
});

describe("C-Q06 the budget spent while hashing keeps the listing", () => {
  it("later images get sha256 null and one warning", () => {
    const probe = mustOpen(g.rasterPdf());
    probe.listImages(1, { hash: false });
    const doc = mustOpen(g.rasterPdf(), {
      limits: { maxTotalDecoded: probe.file.budget.decoded + 200 },
    });
    const list = doc.listImages(1);
    expect(list.images).toHaveLength(6);
    expect(list.images.some((i) => i.sha256 === null)).toBe(true);
    const w = list.diagnostics.filter((d) => d.code === "pdf/too-large");
    expect(w).toHaveLength(1);
    expect(w[0]?.severity).toBe("warning");
  });

  it("the per-call hash budget degrades to sha256 null", () => {
    const list = mustOpen(g.rasterPdf(), { limits: { maxHashBytes: 10 } }).listImages(1);
    expect(list.images.filter((i) => i.sha256 !== null).length).toBeLessThan(6);
    expect(list.diagnostics.filter((d) => d.params.scope === "hash")).toHaveLength(1);
  });
});

describe("C-Q08 JPEG checks", () => {
  it("requires FF D8 FF and a frame header before the scan", () => {
    expect(isJpeg(g.JPEG_16x8)).toBe(true);
    expect(isJpeg(Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]))).toBe(false);
    expect(isJpeg(Uint8Array.from([0xff, 0xd8, 0x00, 0x00]))).toBe(false);
    expect(isJpeg(Uint8Array.from([0xff, 0xd8, 0xff, 0xda, 0, 2]))).toBe(false);
  });

  it("notes an /SMask or /Decode that passthrough does not apply", () => {
    const doc = mustOpen(
      g.onePage("/Im1 Do", IMG, [
        [
          10,
          g.imageDict(16, 8, "/DeviceRGB", 8, "/Filter /DCTDecode /Decode [1 0 1 0 1 0]"),
          g.JPEG_16x8,
        ],
      ]),
    );
    const d = findDiag(doc.extractImage(1, 0).diagnostics, "pdf/colour-approx", "info");
    expect(d.params.ignored).toEqual(["/Decode"]);
    // an ignored soft mask is not a colour approximation (N07)
    const withMask = mustOpen(
      g.onePage("/Im1 Do", IMG, [
        [10, g.imageDict(16, 8, "/DeviceRGB", 8, "/Filter /DCTDecode /SMask 11 0 R"), g.JPEG_16x8],
        [11, g.imageDict(1, 1, "/DeviceGray", 8), Uint8Array.from([1])],
      ]),
    ).extractImage(1, 0).diagnostics;
    expect(codes(withMask)).not.toContain("pdf/colour-approx");
    expect(findDiag(withMask, "pdf/malformed", "info").params.ignored).toEqual(["/SMask"]);
  });
});

describe("C-Q09 Indexed over an approximated base", () => {
  it("reports pdf/colour-approx", () => {
    const doc = mustOpen(
      g.onePage("/Im1 Do", IMG, [
        [
          10,
          g.imageDict(1, 1, "[/Indexed [/Separation /S /DeviceGray 11 0 R] 1 <00ff>]", 8),
          Uint8Array.from([1]),
        ],
        [11, "<< >>"],
      ]),
    );
    findDiag(doc.extractImage(1, 0).diagnostics, "pdf/colour-approx", "warning");
  });
});

describe("C-Q12 TJ spacing", () => {
  it("an adjustment of exactly -200 reads as a space", () => {
    const pdf = g.onePage("BT /F 10 Tf [(a) -200 (b) -199 (c)] TJ ET", "/Font << /F 10 0 R >>", [
      [10, "<< /Type /Font /Subtype /Type1 >>"],
    ]);
    expect(mustOpen(pdf).text(1).runs[0]?.text).toBe("a bc");
  });
});

describe("C-Q14 image caches are keyed by resources too", () => {
  it("one image stream with a named colour space resolves per page", () => {
    const w = new g.PdfWriter();
    w.obj(1, "<< /Type /Catalog /Pages 2 0 R >>");
    w.obj(2, "<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>");
    w.obj(
      3,
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 10 10] /Contents 5 0 R /Resources << /XObject << /Im1 6 0 R >> /ColorSpace << /CS0 /DeviceGray >> >> >>",
    );
    w.obj(
      4,
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 10 10] /Contents 5 0 R /Resources << /XObject << /Im1 6 0 R >> /ColorSpace << /CS0 [/Indexed /DeviceRGB 255 7 0 R] >> >> >>",
    );
    w.obj(5, "<< >>", g.bytes("/Im1 Do"));
    w.obj(
      6,
      "<< /Type /XObject /Subtype /Image /Width 3 /Height 1 /ColorSpace /CS0 /BitsPerComponent 8 >>",
      Uint8Array.from([0, 1, 2]),
    );
    w.obj(7, "<< >>", new Uint8Array(768).fill(9));
    w.xref("/Root 1 0 R");
    const doc = mustOpen(w.bytes());
    const a = doc.listImages(1).images[0];
    const b = doc.listImages(2).images[0];
    expect(a?.colourSpace).toBe("DeviceGray");
    expect(b?.colourSpace).toBe("Indexed(DeviceRGB)");
    expect(a?.sha256).not.toBe(b?.sha256);
  });
});
