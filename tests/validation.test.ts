/**
 * Validation rules (brief §4). These are pure-function tests over the exact
 * cases the brief calls out: repeated, reordered and lost placeholders, token
 * syntax we do not handle, stale hashes, byte limits, empty replacements.
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  MAX_ENTRY_BYTES,
  analyzeSyntax,
  edgeWhitespace,
  sameMultiset,
  countItems,
  validateTranslation,
  type ValidateInput,
} from "../src/validation.js";

const HASH = "a".repeat(64);
const OTHER_HASH = "b".repeat(64);

function input(overrides: Partial<ValidateInput> & { sourceText: string; text?: string }): ValidateInput {
  return {
    catalogSourceHash: HASH,
    metadataSourceHash: HASH,
    text: "Tere",
    state: "reviewed",
    includeUnreviewed: false,
    ...overrides,
  };
}

function codes(issues: { code: string }[]): string[] {
  return issues.map((issue) => issue.code).sort();
}

describe("syntax analysis", () => {
  it("accepts the supported simple substitutions", () => {
    for (const placeholder of [
      "{0.SimFirstName}",
      "{1.String}",
      "{0.Number}",
      "{0.Money}",
      "{0.SimName}",
      "{0.ObjectName}",
      "{0.TimeShort}",
    ]) {
      const analysis = analyzeSyntax(`Tere ${placeholder}!`);
      assert.equal(analysis.problem, undefined, placeholder);
      assert.deepEqual(analysis.placeholders, [placeholder]);
    }
  });

  it("defers gender and plural branches instead of freezing English inside them", () => {
    for (const text of ["{M0.his} sim", "{F0.she} läks", "{S0.is} ready", "{P0.packs}"]) {
      assert.match(analyzeSyntax(text).problem ?? "", /does not handle/, text);
    }
  });

  it("defers pronoun expressions and modifier forms", () => {
    assert.match(
      analyzeSyntax("{0.SimPronounSubjective}").problem ?? "",
      /not one of the value names/
    );
    assert.match(
      analyzeSyntax("{0.SimPronounSubjective|xxUpper}").problem ?? "",
      /does not handle/
    );
  });

  it("defers markup, whose reflow rules are not handled yet", () => {
    assert.match(analyzeSyntax('<span class="pink">Tere</span>').problem ?? "", /markup/);
    assert.match(analyzeSyntax("<b>Tere</b>").problem ?? "", /markup/);
    // A plain less-than sign is not markup.
    assert.equal(analyzeSyntax("1 < 2 ja 3 > 2").problem, undefined);
  });

  it("defers unbalanced or nested braces", () => {
    assert.match(analyzeSyntax("{0.String").problem ?? "", /no closing/);
    assert.match(analyzeSyntax("Tere}").problem ?? "", /no opening/);
    assert.match(analyzeSyntax("{{0.String}}").problem ?? "", /nested/);
  });

  it("collects escapes and inline codes as structural tokens", () => {
    const analysis = analyzeSyntax("Rida\\nTeine [PH] lõpp");
    assert.equal(analysis.problem, undefined);
    assert.deepEqual(analysis.tokens, ["\\n", "[PH]"]);
  });

  it("does not treat a literal percent sign as a formatting token", () => {
    const analysis = analyzeSyntax("100% kindel");
    assert.equal(analysis.problem, undefined);
    assert.deepEqual(analysis.tokens, []);
  });
});

describe("multiset comparison", () => {
  it("detects a lost repetition", () => {
    const source = countItems(["{0.String}", "{0.String}"]);
    const translation = countItems(["{0.String}"]);
    assert.equal(sameMultiset(source, translation), false);
  });

  it("allows reordering", () => {
    const source = countItems(["{0.String}", "{1.Number}"]);
    const translation = countItems(["{1.Number}", "{0.String}"]);
    assert.equal(sameMultiset(source, translation), true);
  });
});

describe("translation validation", () => {
  it("accepts a reviewed translation whose placeholders match", () => {
    assert.deepEqual(
      validateTranslation(
        input({
          sourceText: "Hello, {0.SimFirstName}!",
          text: "Tere, {0.SimFirstName}!",
        })
      ),
      []
    );
  });

  it("accepts a reordered translation but rejects a lost repetition", () => {
    assert.deepEqual(
      validateTranslation(
        input({ sourceText: "{0.String} ja {1.Number}", text: "{1.Number} ja {0.String}" })
      ),
      []
    );
    assert.deepEqual(
      codes(
        validateTranslation(
          input({ sourceText: "{0.String} ja {0.String}", text: "Ainult {0.String}" })
        )
      ),
      ["placeholder-mismatch"]
    );
    assert.deepEqual(
      codes(validateTranslation(input({ sourceText: "Tere", text: "Tere {0.String}" }))),
      ["placeholder-mismatch"]
    );
  });

  it("rejects a lost line break or inline code", () => {
    assert.deepEqual(
      codes(validateTranslation(input({ sourceText: "Rida\\nTeine", text: "Rida teine" }))),
      ["token-mismatch"]
    );
    assert.deepEqual(
      codes(validateTranslation(input({ sourceText: "Helista [PH]", text: "Helista" }))),
      ["token-mismatch"]
    );
  });

  it("rejects a translation using syntax we defer, but leaves the English alone", () => {
    assert.deepEqual(
      codes(validateTranslation(input({ sourceText: "Simple text", text: "{M0.his} tekst" }))),
      ["unsupported-syntax"]
    );
    assert.deepEqual(
      codes(
        validateTranslation(
          input({ sourceText: "{M0.his} sim", text: "{M0.his} tegelane" })
        )
      ),
      ["unsupported-syntax"]
    );
  });

  it("rejects a stale source hash", () => {
    assert.deepEqual(
      codes(validateTranslation(input({ sourceText: "New Game", metadataSourceHash: OTHER_HASH }))),
      ["stale-source"]
    );
  });

  it("rejects missing or malformed metadata", () => {
    assert.deepEqual(
      codes(validateTranslation(input({ sourceText: "New Game", metadataSourceHash: undefined }))),
      ["missing-metadata"]
    );
    assert.deepEqual(
      codes(
        validateTranslation(
          input({ sourceText: "New Game", metadataMalformed: "unknown state \"finished\"" })
        )
      ),
      ["malformed-metadata"]
    );
  });

  it("withholds unreviewed translations unless explicitly included", () => {
    assert.deepEqual(
      codes(validateTranslation(input({ sourceText: "New Game", state: "draft" }))),
      ["unreviewed"]
    );
    assert.deepEqual(
      validateTranslation(input({ sourceText: "New Game", state: "draft", includeUnreviewed: true })),
      []
    );
    assert.deepEqual(
      validateTranslation(input({ sourceText: "New Game", state: "machine", includeUnreviewed: true })),
      []
    );
  });

  it("rejects an empty replacement of non-empty English", () => {
    assert.deepEqual(
      codes(validateTranslation(input({ sourceText: "New Game", text: "" }))),
      ["empty-replacement"]
    );
    // Whitespace-only is an empty replacement, and it also drops the English
    // text's (empty) edges — both are reported.
    assert.deepEqual(
      codes(validateTranslation(input({ sourceText: "New Game", text: "   " }))),
      ["edge-whitespace-mismatch", "empty-replacement"]
    );
  });

  it("allows filling in an empty English string", () => {
    assert.deepEqual(
      validateTranslation(input({ sourceText: "", text: "Täidetud", metadataSourceHash: HASH })),
      []
    );
  });

  it("does not count the English text as a translation", () => {
    assert.deepEqual(
      codes(validateTranslation(input({ sourceText: "New Game", text: "New Game" }))),
      ["identical-to-source"]
    );
  });

  it("does not count an empty-to-empty pair as a translation either", () => {
    // Nothing about the emitted table would change, so this must not make a
    // table count as "affected" and must not be reported as applied.
    assert.deepEqual(
      codes(validateTranslation(input({ sourceText: "", text: "" }))),
      ["identical-to-source"]
    );
  });

  it("measures the UTF-8 byte length, not the character count", () => {
    // 33,000 Estonian letters: under the 16-bit limit when counted as characters
    // (33,000 < 65,535) but over it as UTF-8 bytes (õ is two bytes each).
    const long = "õ".repeat(33_000);
    assert.ok(long.length < MAX_ENTRY_BYTES, "character count stays under the limit");
    assert.ok(Buffer.byteLength(long, "utf8") > MAX_ENTRY_BYTES, "byte length does not");
    assert.deepEqual(
      codes(validateTranslation(input({ sourceText: "New Game", text: long }))),
      ["too-long-utf8"]
    );
  });

  it("rejects invalid text", () => {
    assert.deepEqual(
      codes(validateTranslation(input({ sourceText: "New Game", text: "Tere\u0000" }))),
      ["invalid-text"]
    );
    assert.deepEqual(
      codes(validateTranslation(input({ sourceText: "New Game", text: "Tere\ud800" }))),
      ["invalid-text"]
    );
  });

  it("keeps structurally required surrounding whitespace", () => {
    assert.deepEqual(
      codes(validateTranslation(input({ sourceText: " New Game ", text: "Uus mäng" }))),
      ["edge-whitespace-mismatch"]
    );
    assert.deepEqual(
      validateTranslation(input({ sourceText: " New Game ", text: " Uus mäng " })),
      []
    );
  });

  it("refuses to address an ambiguous occurrence", () => {
    assert.deepEqual(
      codes(
        validateTranslation(input({ sourceText: "Tere", text: "Tere tulemast", ambiguous: true }))
      ),
      ["ambiguous-occurrence"]
    );
  });

  it("reports every problem at once instead of stopping at the first", () => {
    const issues = validateTranslation(
      input({ sourceText: "{0.String} tere", text: "", state: "draft", metadataSourceHash: OTHER_HASH })
    );
    assert.deepEqual(codes(issues), [
      "empty-replacement",
      "placeholder-mismatch",
      "stale-source",
      "unreviewed",
    ]);
  });
});

describe("edge whitespace helper", () => {
  it("splits leading and trailing runs", () => {
    assert.deepEqual(edgeWhitespace("  Tere  "), { leading: "  ", trailing: "  " });
    assert.deepEqual(edgeWhitespace("Tere"), { leading: "", trailing: "" });
  });
});
