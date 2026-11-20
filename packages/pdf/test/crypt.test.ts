import { describe, expect, it } from "vitest";
import { rc4 } from "../src/crypt.js";
import { openPdf } from "../src/index.js";
import { findDiag, mustOpen } from "./helpers.js";
import * as g from "./fixtures/gen.js";

const plain = mustOpen(g.rasterPdf());
const plainHashes = [1, 2].map((p) => plain.listImages(p).images.map((i) => i.sha256));

const VARIANTS: [g.CryptKind, { v: number; r: number; keyBits: number; streams: string }][] = [
  ["rc4-40", { v: 1, r: 2, keyBits: 40, streams: "RC4" }],
  ["rc4-128", { v: 2, r: 3, keyBits: 128, streams: "RC4" }],
  ["rc4-v4", { v: 4, r: 4, keyBits: 128, streams: "RC4" }],
  ["aes-128", { v: 4, r: 4, keyBits: 128, streams: "AES-128" }],
  ["aes-256-r5", { v: 5, r: 5, keyBits: 256, streams: "AES-256" }],
  ["aes-256-r6", { v: 5, r: 6, keyBits: 256, streams: "AES-256" }],
];

describe("standard security handler, empty user password", () => {
  it("RC4 matches the published test vectors", () => {
    const hexOf = (b: Uint8Array): string => g.hex(b);
    expect(hexOf(rc4(g.bytes("Key"), g.bytes("Plaintext")))).toBe("bbf316e8d940af0ad3");
    expect(hexOf(rc4(g.bytes("Wiki"), g.bytes("pedia")))).toBe("1021bf0420");
    expect(hexOf(rc4(g.bytes("Secret"), g.bytes("Attack at dawn")))).toBe(
      "45a01f645fc35b383552544b9bf5",
    );
  });

  for (const [kind, want] of VARIANTS) {
    it(`decrypts ${kind}: strings, streams, palette, identical images`, () => {
      const pdf = g.encryptedPdf({ kind });
      // the producer string is really encrypted (the plain fixture writes it as hex)
      const producerHex = g.hex(g.bytes("Synthetic Writer 1.0"));
      expect(String.fromCharCode(...g.rasterPdf())).toContain(producerHex);
      expect(String.fromCharCode(...pdf)).not.toContain(producerHex);
      const r = openPdf(pdf);
      expect(r.ok).toBe(true);
      findDiag(r.diagnostics, "pdf/encrypted", "info");
      const doc = mustOpen(pdf);
      const info = doc.info();
      expect(info.encryption).toMatchObject({
        filter: "Standard",
        ...want,
        strings: want.streams,
        permissions: -3904,
      });
      expect(info.producer).toBe("Synthetic Writer 1.0");
      for (const p of [1, 2]) {
        const list = doc.listImages(p);
        expect(list.diagnostics).toEqual([]);
        expect(list.images.map((i) => i.sha256)).toEqual(plainHashes[p - 1]);
      }
    });
  }

  it("derives the key without metadata when /EncryptMetadata is false (R4)", () => {
    const doc = mustOpen(g.encryptedPdf({ kind: "aes-128", encryptMetadata: false }));
    expect(doc.info().encryption?.encryptMetadata).toBe(false);
    expect(doc.listImages(1).images.map((i) => i.sha256)).toEqual(plainHashes[0]);
  });

  for (const kind of ["rc4-40", "rc4-128", "aes-128", "aes-256-r5", "aes-256-r6"] as const) {
    it(`refuses ${kind} with a user password (pdf/encrypted)`, () => {
      const r = openPdf(g.encryptedPdf({ kind, userPassword: "secret" }));
      expect(r.ok).toBe(false);
      const d = findDiag(r.diagnostics, "pdf/encrypted", "error");
      expect(d.message).toMatch(/user password/);
    });
  }

  it("refuses other handlers and versions", () => {
    for (const enc of [
      "<< /Filter /Adobe.PubSec /V 4 /R 4 >>",
      "<< /Filter /Standard /V 3 /R 3 /O <00> /U <00> /P 0 >>",
      "<< /Filter /Standard /V 2 /R 7 /O <00> /U <00> /P 0 >>",
      "<< /Filter /Standard /V 2 /R 3 /P 0 >>",
      "<< /Filter /Standard /V 4 /R 4 /O <00> /U <00> /P 0 /CF << /StdCF << /CFM /Bogus >> >> /StmF /StdCF /StrF /StdCF >>",
    ]) {
      const w = new g.PdfWriter();
      w.obj(1, "<< /Type /Catalog /Pages 2 0 R >>");
      w.obj(2, "<< /Type /Pages /Kids [] /Count 0 >>");
      w.obj(3, enc);
      w.xref(`/Root 1 0 R /Encrypt 3 0 R /ID [<00> <00>]`);
      const r = openPdf(w.bytes());
      expect(r.ok, enc).toBe(false);
      findDiag(r.diagnostics, "pdf/encrypted", "error");
    }
  });

  it("decrypts object streams as a whole (strings inside are not decrypted twice)", () => {
    const sec = new g.Security({ kind: "aes-128" });
    const w = new g.PdfWriter(sec, "%PDF-1.5\n");
    w.obj(1, "<< /Type /Catalog /Pages 2 0 R >>");
    w.objStm(7, [
      [2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>"],
      [
        3,
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 10 10] /Contents 4 0 R /Resources << /XObject << /Im1 5 0 R >> >> >>",
      ],
      [6, "<< /Producer (in objstm) >>"],
    ]);
    w.obj(4, "<< >>", g.bytes("q 10 0 0 10 0 0 cm /Im1 Do Q"));
    w.obj(5, g.imageDict(3, 2, "/DeviceGray", 8), g.GRAY_3x2);
    w.obj(99, sec.dict, undefined, { plain: true });
    w.xrefStream(
      8,
      `/Root 1 0 R /Info 6 0 R /Encrypt 99 0 R /ID [<${g.hex(g.FILE_ID)}> <${g.hex(g.FILE_ID)}>]`,
    );
    const doc = mustOpen(w.bytes());
    expect(doc.info().producer).toBe("in objstm");
    expect(doc.listImages(1).images).toHaveLength(1);
    expect(doc.extractImage(1, 0).ok).toBe(true);
  });
});
