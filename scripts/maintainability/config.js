export const DEFAULT_FILE_LINES = 500;

export const FILE_LINE_EXEMPTIONS = Object.freeze([
  {
    file: "src/core/facts/admission.ts",
    max: 550,
    reason: "Admission remains one authority owner; split only at an owned boundary.",
  },
]);
