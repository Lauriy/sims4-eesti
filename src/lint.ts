/**
 * Estonian text that carries forms Estonian does not build.
 *
 * The failure this exists for, reported from a playtest: the "Flirt" interaction
 * was translated "Flirttaile", which is the Finnish word - EA's Finnish says
 * "Flirttaile" for the same key and a translator gave it back unchanged.
 * "flirttailla" is a Finnish verb; Estonian has "flirtima", imperative "flirta".
 *
 * Two detectors were tried on the real output. Rarity - "a word used once that
 * also appears in the Finnish" - found three strings and all three were innocent
 * Estonian loanwords (teline, kitara, fantasia), while missing the actual defect,
 * which appears three times. Morphology is the signal that works: Estonian does
 * not end words in -ailla, -inen, -ssa, -minen or -matta, so a word that does is
 * either a copy from Finnish or a word nobody has ever written down. Measured on
 * the 4,043 translated strings: 3 hits, all the same real defect, 0 false
 * positives.
 *
 * Known limit, from the same playtest: "Vehtle" for the WooHoo interaction was
 * built by taking the Finnish stem "veht-" from a *different* key's reference and
 * adding Estonian verb grammar. No ending rule catches that, because the ending is
 * Estonian and the stem is copied. It was found by a player, not by this. The
 * remaining defence is the one that found both: a human reading the game.
 *
 * It reports; it never rewrites. Estonian has borrowed from Finnish for centuries
 * and a form that looks Finnish is not proof of a mistake - "kuninkaallinen" is a
 * word, "-llinen" is Estonian, and the reader decides.
 */
import type { CatalogOccurrence } from "./catalog.js";
import type { TranslationMap } from "./translations.js";

/** Word endings Estonian does not produce, with what they usually are in Finnish. */
const FOREIGN_ENDINGS: { pattern: RegExp; note: string }[] = [
  // -ailla / -äillä / -aile: the Finnish verb family the playtest caught.
  // "flirttailla" is Finnish; Estonian has "flirtima", imperative "flirta".
  { pattern: /\p{L}{4,}ailla(?![\p{L}\p{N}_])/giu, note: "Finnish verb form (-ailla); Estonian uses -ma/-da" },
  { pattern: /\p{L}{4,}äillä(?![\p{L}\p{N}_])/giu, note: "Finnish verb form (-äillä)" },
  { pattern: /\p{L}{4,}aile(?![\p{L}\p{N}_])/giu, note: "Finnish verb form (-aile); Estonian uses -ma/-da" },
  { pattern: /\p{L}{4,}äile(?![\p{L}\p{N}_])/giu, note: "Finnish verb form (-äile)" },
  { pattern: /\p{L}{4,}ailu(?![\p{L}\p{N}_])/giu, note: "Finnish verbal noun (-ailu); Estonian uses -mine" },
  { pattern: /\p{L}{4,}inen(?![\p{L}\p{N}_])/giu, note: "Finnish adjective (-inen); Estonian uses -ne or -line" },
  { pattern: /\p{L}{4,}ssa(?![\p{L}\p{N}_])/giu, note: "Finnish inessive (-ssa); Estonian uses -s" },
  { pattern: /\p{L}{4,}ssä(?![\p{L}\p{N}_])/giu, note: "Finnish inessive (-ssä); Estonian uses -s" },
  { pattern: /\p{L}{4,}minen(?![\p{L}\p{N}_])/giu, note: "Finnish verbal noun (-minen); Estonian uses -mine" },
  { pattern: /\p{L}{4,}matta(?![\p{L}\p{N}_])/giu, note: "Finnish abessive (-matta); Estonian uses -mata" },
  { pattern: /\p{L}{4,}ttava(?![\p{L}\p{N}_])/giu, note: "Finnish participle (-ttava); Estonian uses -tav" },
  { pattern: /\p{L}{4,}ttävä(?![\p{L}\p{N}_])/giu, note: "Finnish participle (-ttävä); Estonian uses -tav" },
];

export interface ForeignForm {
  occurrenceId: string;
  english: string;
  estonian: string;
  form: string;
  note: string;
  /** True when the same form appears in the reference translation of this key. */
  inReference?: boolean;
}

export interface LintResult {
  checked: number;
  findings: ForeignForm[];
}

/**
 * Finds words in the translations whose shape Estonian does not build. When the
 * reference language is supplied, a finding that also appears there is marked:
 * that is not a suspicious word, it is a copied one.
 */
export function findForeignForms(
  occurrences: CatalogOccurrence[],
  translations: TranslationMap,
  reference?: Map<string, string>
): LintResult {
  const findings: ForeignForm[] = [];
  let checked = 0;
  for (const occurrence of occurrences) {
    const estonian = translations[occurrence.occurrenceId];
    if (estonian === undefined) continue;
    checked += 1;
    const finnish = reference?.get(occurrence.stringKey.toUpperCase().padStart(8, "0"));
    for (const { pattern, note } of FOREIGN_ENDINGS) {
      pattern.lastIndex = 0;
      const match = pattern.exec(estonian);
      if (!match) continue;
      const form = match[0];
      // A form that is also in the English is a name or a loanword carried over,
      // not a Finnish copy: "Melissa" ends in -ssa and appears in both languages.
      if (occurrence.sourceText.toLowerCase().includes(form.toLowerCase())) continue;
      findings.push({
        occurrenceId: occurrence.occurrenceId,
        english: occurrence.sourceText,
        estonian,
        form,
        note,
        ...(finnish?.toLowerCase().includes(form.toLowerCase()) ? { inReference: true } : {}),
      });
      break;
    }
  }
  return { checked, findings };
}
