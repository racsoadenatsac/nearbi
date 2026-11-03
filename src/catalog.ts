// Seed catalog. The free sample is public (served from the static site); other reports live in S3.
import type { ReportRecord } from "./ports/repository";

export const SEED_REPORTS: ReportRecord[] = [
  {
    slug: "near-thesis",
    title: "NEAR thesis: does Intents volume lead real usage?",
    summary:
      "The data rejected our own hypothesis: neither Intents volume nor the NEAR price leads real-user growth. Intents grew 521.4x while real users outside KaiChing fell 92.3%.",
    publishedAt: "2026-11-02",
    isFree: true,
    pdfFile: "NEAR-thesis-intents-vs-real-usage.pdf",
  },
  {
    slug: "near-users-vs-bots",
    title: "NEAR activity: real users or bots?",
    summary:
      "90 signers (0.01%) produced 80.7% of NEAR transactions over 30 days. Evidence for, against, and how to check it yourself.",
    publishedAt: "2026-11-02",
    isFree: true,
    pdfFile: "NEAR-real-users-or-bots.pdf",
  },
];
