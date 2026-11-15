# Annotation guidelines: Indian financial news headlines

Version 1.2 (November 2026). Every label below is checked by `research/schema.py`; a label that breaks a rule is refused when you save it, with the reason.

**Where to label:** the **Research** tab in the app (sign in, then Research in the sidebar). Every field is a button or a search box, and progress is saved per headline. The admin assigns who is annotator A and B under Research → Annotators. The CSV sheets in `data/corpus/` remain as a fallback only; use one or the other, not both.

## What you are labelling

Each row is one headline from an Indian business publication, with its source and time. Label **only what the headline says**. Do not open the article, use what you know happened later, or reason about what the price did next. If the headline alone does not settle a question, take the more cautious answer: `neutral`, `none`, or `other`.

You fill six fields: `sentiment`, `events`, `severity`, `scope`, `companies`, `sectors`. Use `notes` for anything unusual. (In the CSV fallback, cells with several values use `;` between them, for example `regulatory_action;fraud_default`.)

## 1. Sentiment: `negative`, `neutral` or `positive`

Ask: *for an investor holding the company, sector or market the headline is about, is this news good, bad, or neither?*

| Label | Use when | Examples |
|---|---|---|
| `positive` | Good for the holder: results beat, order wins, upgrades, approvals, rate cuts the market wanted | "Infosys wins $1.5 bn deal from European bank" · "USFDA clears Sun Pharma's Halol plant" |
| `negative` | Bad for the holder: losses, misses, regulatory action, fraud, defaults, downgrades, war or crisis | "SEBI bars promoter over fund diversion" · "Tata Steel profit falls 40% on weak demand" |
| `neutral` | Factual or scheduled with no clear direction, or mixed news | "Reliance to hold AGM on Friday" · "Markets end flat ahead of RBI policy" |

Rules:

- **Use the holder's view, not the verb.** "Short-sellers lose as Adani stocks rally" is `positive`.
- **Negation flips the label.** "RBI does **not** hike rates" is `positive` for rate-sensitive stocks, and "No fraud found in audit" is `positive`.
- **Mixed news is `neutral`** unless one side clearly dominates: "Profit rises 5% but margins shrink" is `neutral`.
- **Expectations count when they are stated.** "Profit rises 10%, below estimates" is `negative`.
- **Questions and opinion columns** ("Is it time to buy IT stocks?") are `neutral`.

## 2. Events (one or more types)

| Type | Covers | Examples |
|---|---|---|
| `regulatory_action` | Orders, bans, probes, penalties or approvals by SEBI, RBI, ED, CBI, NCLT, CCI, USFDA or a ministry | "SEBI orders forensic audit of …" · "RBI imposes penalty on …" |
| `fraud_default` | Fraud, fund diversion, default, insolvency, auditor resignation, governance failure | "Lender misses coupon payment" · "Auditor quits citing lack of information" |
| `monetary_policy` | RBI rate, liquidity or stance decisions; inflation prints | "RBI holds repo rate at 6.5%" · "CPI inflation eases to 4.2%" |
| `earnings_guidance` | Quarterly results, guidance, rating changes, broker target changes | "TCS Q2 profit up 8%" · "Moody's downgrades …" |
| `corporate_action` | M&A, demerger, buyback, dividend, fund-raise, capex, plant opening or shutdown, layoffs, management change, large orders | "ITC Hotels demerger approved" · "L&T bags ₹5,000 crore order" |
| `macro_geopolitical` | War, terror, pandemic, sanctions, tariffs, GDP, rupee, crude oil, tax and budget policy, elections | "Rupee hits record low" · "Govt raises windfall tax on crude" |
| `flows` | FII/DII flows, block and bulk deals, promoter pledges and stake sales, index inclusion | "FIIs sell ₹8,000 crore in a week" · "Promoter pledges 20% stake" |
| `other` | Market commentary, price moves with no stated cause, anything not above | "Sensex rises 300 points" · "5 stocks to watch today" |

Rules:

- Pick **every** type that applies. "SEBI bars promoter for fraud" is `regulatory_action;fraud_default`.
- `other` is used **alone**. Never combine it with another type.
- A price move with a stated cause gets the cause's type: "Sensex falls 900 points as US tariffs bite" is `macro_geopolitical`.

## 3. Severity: `none`, `low`, `medium` or `high`

How much the event *could* hurt holders. Rate good news `none` (severity is about downside only).

| Level | Meaning | Examples |
|---|---|---|
| `none` | Not adverse | Order wins, results beats, routine announcements |
| `low` | Minor or routine adverse news | Small target cut, small profit dip, routine penalty under ₹1 crore |
| `medium` | Material adverse news, but not existential | Profit falls 30%, rating downgrade, probe launched, guidance cut |
| `high` | Severe: could cause a large, sudden loss | Fraud, default, SEBI or RBI ban, insolvency, war, market crash, circuit breaker |

## 4. Scope: `market`, `sector`, `company` or `none`

Who is directly affected.

| Scope | Use when | Examples |
|---|---|---|
| `market` | The whole Indian market: index-level moves, RBI policy, war, budget, rupee, FII flows in aggregate | "Sensex crashes 1,200 points" · "RBI cuts repo rate" |
| `sector` | One sector or industry, with no single company named as the subject | "Govt cuts import duty on solar modules" · "IT stocks fall on US visa curbs" |
| `company` | One or more named companies are the subject | "HDFC Bank Q2 profit up 18%" |
| `none` | Not about Indian listed equities | "Gold prices rise in Dubai" |

A `market`-scope, `high`-severity headline is exactly what the market-wide news guard should halt on. Be strict: a single company's fraud is `company` scope, however large the company.

`company` scope needs at least one NSE-listed company in `companies`. A headline whose subject is an **unlisted or foreign company** (Myntra, PhonePe, Oyo, Disney, Garena, Nabard) is `none`, even when it is Indian business news. A headline about a business **group** only (Tata group, Adani Group) is also `none` unless it names a listed group company.

## 5. Companies: NSE symbols, `;`-separated

List every NSE-listed company that the headline is **about**, as symbols with `.NS` (`TCS.NS;INFY.NS`). You may write just `TCS`; the importer adds `.NS`.

- **Group names are not companies.** "Tata group to invest in chips" has **no** company: leave it empty and write "group: Tata" in notes. Link "Tata Steel" to `TATASTEEL.NS` only when the headline names that company.
- **Subsidiaries:** link the listed entity the headline names. "Reliance Jio adds subscribers" links to `RELIANCE.NS`, because Jio is unlisted and owned by RIL. "Jio Financial" links to `JIOFIN.NS`.
- **Not a company:** "State" in "state elections", "BSE" meaning the exchange or its index, "Power" in "power ministry", "Indian Oil" when the phrase means oil in India.
- **Unlisted or foreign companies** are not linked (Oracle Corp, unlisted startups). Note them if relevant.
- **IPOs:** link the company if it is listed on NSE today (the search finds it); otherwise leave it unlinked and use scope `none`.
- When unsure of a symbol, type the name into the companies box in the Research tab (it searches the full NSE list) or check nseindia.com. **Do not** use the app's news links or any automatic linker output to fill this column. This column is the gold standard that the linker is scored against.

## 6. Sectors

One or more of: `IT`, `Banking & Finance`, `Pharma & Healthcare`, `Oil & Gas`, `Metal`, `Energy & Power`, `Manufacturing`, `FMCG`, `Services`. Leave empty for market-wide or unclear headlines.

## Process

1. **Calibration.** Both annotators label the same 50 headlines (taken from the `train` split), then compare and discuss every disagreement. Add any new rule to this file under *Decisions log* and increase the version number. Calibration items are excluded from the agreement statistics.
2. **Independent labelling.** Annotator A labels the full sample. Annotator B labels only the double-annotated subset (300 rows; the Research tab shows B only those), **without seeing A's labels**. Both annotators start from the same LLM pre-label (see below), and do not discuss rows until both have finished.
3. **Agreement.** Run `python -m research.agreement` on the two files. Report Cohen's kappa per field. Below 0.6 on sentiment means the guidelines need another calibration round.
4. **Adjudication.** Disagreements in the double subset are settled by discussion. The settled label becomes gold, and the original pair is kept for the kappa calculation.

### LLM pre-labels

From version 1.2, **every row is pre-filled for both annotators**, in all six fields, by an LLM (Claude, model `claude-opus-5-5`) that applied these guidelines. Company symbols were checked against the NSE list. The file is `data/annotation/prelabels.jsonl`; the earlier Gemini pre-labels for 449 rows are kept in `prelabels_gemini.jsonl` for comparison.

- Each pre-label must be **reviewed** before it counts. Read the headline first, then check every field, including the company name shown next to each symbol. In the Research tab, saving the row is the review. Reviewed rows are stored with `origin` = `human_verified`, together with the pre-label that was shown.
- Judge every pre-filled row as if it were blank. Do not keep a label just because it is already there.
- Pre-filled labels are wrong often enough to matter: on the 449 rows both LLMs labelled, they agreed on sentiment only 77% of the time.
- **What this means for the results.** Both annotators review the same pre-label, so kappa on the double subset measures agreement *between two people correcting the same draft*. It will be higher than agreement from blank sheets. The write-up must say so and also report, for each annotator, how often they changed each field (`import-db` prints this). The gold test labels are LLM-drafted and human-corrected, which also must be stated.
- A row you labelled before v1.2 keeps the pre-label it was shown then (or none).

## Decisions log

| Version | Date | Decision |
|---|---|---|
| 1.0 | 2026-11 | Initial rules |
| 1.1 | 2026-11-09 | Section 4: unlisted, foreign and group-only subjects are scope `none` (`company` needs a linked NSE company). Section 5: IPO rule. Labelling moved to the Research tab. Prompted by a check of the first 449 pre-labels: 34 had `company` scope for unlisted or foreign firms |
| 1.2 | 2026-11-09 | All 3,000 rows pre-filled for both annotators, all six fields, by Claude (`claude-opus-5-5`); the test split and the double subset are no longer blank. Chosen by the researcher to reduce the labelling load. Consequences, to be reported: kappa is pre-label-assisted agreement, and gold labels are human-corrected LLM drafts. Per-annotator change rates are reported with every export. |
| 1.3 | 2026-11-10 | Train and dev use the LLM labels as silver (`origin` = `llm_prelabel`; `build_sample gold`). Human review is needed only for the test split (annotator A, the answer key) and the double subset (annotator B, for kappa); the Research tab lists these under **Needs review**. Based on A's first 145 reviewed rows: 17% changed, mostly sentiment. The human-only variant (`--no-silver`) is kept for an ablation. |
