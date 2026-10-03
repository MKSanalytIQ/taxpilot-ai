# TaxPilot AI

AI-assisted ITR-3 / ITR-4 preparation for **Assessment Year 2026–27**.

TaxPilot AI is an independent tax preparation product. It is **not** affiliated with or endorsed by the Income Tax Department. It does **not** log in to the e-filing portal and never stores portal credentials.

Tax calculations and return preparation are software assistance. Review them before filing.

## What this release does

End-to-end ITR-4 vertical slice:

Signup → dashboard → create return → eligibility (deterministic) → interview → income → deductions → TDS/bank → validation → summary → ITR JSON download.

ITR-3 has data models and screens (P&L / balance sheet tables) but not a complete official mapper.

Document OCR uses Google Vision when `OCR_PROVIDER` and `GOOGLE_VISION_API_KEY` are set. Unconfigured OCR does not invent values. Payments verify Razorpay checkout and webhook signatures. Production documents use a private S3-compatible bucket.

## Tax rules (AY 2026–27)

Versioned under `src/lib/tax-rules/ay2026_27/`.

- New regime slabs (ITD tax-rates): 0 / 4L / 8L / 12L / 16L / 20L / 24L at 0–5–10–15–20–25–30%
- s.87A rebate up to ₹60,000 if taxable income ≤ ₹12 lakh (resident individual, new regime)
- Standard deduction ₹75,000 (new) / ₹50,000 (old) on salary
- Health and education cess 4%
- 44AD: 6% digital + 8% cash; turnover ₹2 cr / ₹3 cr if cash ≤ 5%
- 44ADA: 50% of receipts; ₹50 lakh / ₹75 lakh if cash ≤ 5%
- ITR-4: resident individual/HUF/firm (not LLP), income ≤ ₹50 lakh, presumptive BP, up to two house properties, 112A LTCG ≤ ₹1.25 lakh

Sources: [ITD tax rates](https://www.incometaxindia.gov.in/w/%E2%80%8Btax-rates-1), [ITR-4 FAQs](https://www.incometax.gov.in/iec/foportal/help/all-topics/e-filing-services/file-itr-4-sugam-online).

**Official schema (production authority):** `src/lib/itr-json/schemas/ay2026_27/itr4/schema.json`  
ITR-4_2026_Main_V1.1.json, released 30 Jun 2026, SchemaVer `Ver1.0`, SHA-256 in `metadata.json`.  
Validated with **AJV draft-04**. The old adapter schema is in `.../development/adapter.schema.json` and is **not** used in production.

**ITR-3 is not filing-ready.** JSON download is disabled for ITR-3.

## Run locally

Requires Node 20+. Local development uses PostgreSQL (`docker compose up -d`).

```bash
cp .env.example .env
docker compose up -d
npm install
npx prisma migrate dev
npm run db:seed
npm run dev
```

Open http://127.0.0.1:3002

Demo:

- `demo@taxpilot.local` / `password123`
- `admin@taxpilot.local` / `password123`

```bash
npm test
npm run typecheck
npm run lint
npm run build
```

## Environment

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | PostgreSQL |
| `AUTH_SECRET` | Session JWT |
| `S3_BUCKET`, `S3_ENDPOINT`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_REGION` | Private object storage. Required in production. |
| `OCR_PROVIDER`, `GOOGLE_VISION_API_KEY` | Server-side OCR for scanned PDF and images. |
| `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`, `PRO_PRICE_INR` | Pro checkout and webhook. |
| `RESEND_API_KEY`, `RESET_EMAIL_FROM` or `EMAIL_FROM`, `NEXT_PUBLIC_APP_URL` | Password reset email. |

## Architecture

```
User data → Normalized tax model
  → AY 2026–27 tax engine (normal vs special-rate; 44AD/44ADA; 87A; cess)
  → ITR-4 official mapper
  → AJV validation against official schema
  → Business + tax-calc validation
  → SHA-256 JSON (CURRENT; prior files SUPERSEDED)
```

JSON generation is gated: profile, eligibility, no ERROR issues, official schema pass, bank details, verification. There is no `FILED` status. Maximum: `JSON_GENERATED` / Ready for upload.

Providers (`src/lib/providers`): AI, OCR, storage, payments — swap implementations without touching UI.

## Tests

`npm test` — eligibility, tax engine, deductions, presumptive, official-schema AJV, golden JSON, rounding, authz.

Golden files: `tests/fixtures/itr4/ay2026_27/*.json`

## Production database

Local and production use PostgreSQL (`DATABASE_URL`). Locally, run `npm run db:up`.

## Known limitations

- Official CBDT *business* validation rules PDF is referenced, not executed as a rules engine (JSON Schema + our deterministic rules are applied).
- 44AE vehicles UI is partial.
- ITR-3 and ITR-4 JSON are generated from the official schemas after validation.
- Without `GOOGLE_VISION_API_KEY`, scanned files stay in manual review and are not auto-filed.
- No portal filing.

## Next phase

Document extraction (AIS/26AS/Form 16) with human confirmation, then ITR-3 filing-grade mapping.
