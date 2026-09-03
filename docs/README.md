# Engineering History

These documents are a chronological record of how this project was actually built and published — not current architecture documentation. For how the project works today, see the [root README](../README.md).

They're kept because the process is itself part of what this project demonstrates: a real, messy starting point, a deliberate generalization effort, an honest hardening pass that found and fixed real bugs by actually running the code instead of trusting that it worked, and a verified public release.

| Document | What it is | When |
|---|---|---|
| [PROJECT_AUDIT.md](PROJECT_AUDIT.md) | The original repository archaeology: what was inherited, what worked, what didn't (the validation layer existed but was never wired up), and what needed to change | Phase 1 — initial assessment |
| [ENGINEERING_REPORT.md](ENGINEERING_REPORT.md) | The generalization and integration pass: replacing the hard-coded target with a generic config model and wiring the validation layer into the crawl pipeline | Phase 2 — implementation |
| [FINAL_HARDENING_REPORT.md](FINAL_HARDENING_REPORT.md) | The correctness/security hardening pass: bugs found by actually running the pipeline (a real scope-matching bug, a redirect-chain crash, an anchor-dedup collision, and others), each with a regression test | Phase 3 — hardening |
| [../PORTFOLIO_AUDIT.md](../PORTFOLIO_AUDIT.md) | The repository presentation pass: identity/README rewrite, documentation consolidation, hygiene and metadata review | Phase 4 — portfolio preparation |
| [PUBLICATION_REPORT.md](PUBLICATION_REPORT.md) | The actual GitHub publication: security audit, clean-state verification, push, release, and metadata configuration, with results verified live against the published repository | Phase 5 — publication |

Each document reflects the state of the project **at the time it was written**. Later documents supersede earlier ones where they disagree — always trust the current code and the root README over anything here.
