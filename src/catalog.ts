// Seed catalog: public (free) and subscriber reports only. The free ones are served from the static site;
// subscriber reports live in S3. Reports made for one order never go here: they are stored on the order in
// DynamoDB (see README "Order deliverables") and are readable only by the buyer.
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
