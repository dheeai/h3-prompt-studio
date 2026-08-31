/**
 * Token estimation.
 *
 * A real BPE tokenizer would cost ~2 MB of bundle for a number that only ever
 * drives a budget meter, and every model here tokenizes slightly differently
 * anyway. chars/4 lands within roughly 10% on English markdown and never lies
 * about direction — which is all a budget needs to do. Labelled "est."
 * everywhere it is shown.
 */
export function estTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

export function fmtTokens(n: number): string {
  if (n < 1000) return String(n)
  return `${(n / 1000).toFixed(n < 10000 ? 1 : 0)}k`
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}
