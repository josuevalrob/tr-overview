# tr-overview

A depot overview for Trade Republic, built from its **transaction export**. No account login, no
database, no dependencies.

| Tab | |
|---|---|
| **Today** | every open position at the live LS Exchange price: today's move, value, paid, gain, weight |
| **Months** | what the account earned so far, stocks value vs cost, what each month earned, a month-by-month table |
| **Taxes** | the Sparer-Pauschbetrag used per year, an estimate to 31 Dec, "if you sold everything today", stock sales (FIFO), crypto holding periods |
| **News** | Google News headlines (English / German) for every holding, plus any stock you choose to follow |

## Run it

Node 20 or newer. Nothing to install.

```bash
node server.mjs            # http://localhost:3000   (PORT=8080 node server.mjs to change)
npm run check              # offline checks of the model against the sample
```

Open the page, then either **Try with sample data** or upload your own export.

## Getting the export

In Trade Republic: **Statements → Transaction export** (CSV). Export all time, or any range —
upload a fresh one whenever you like. Overlapping exports are merged by `transaction_id`, so
nothing is counted twice.

The monthly *Account statement* is a PDF with net amounts only (no fee, no tax) and is not read.

## Privacy

- The CSV stays **in your browser** (localStorage). It is sent with each request so the server can
  calculate, and the server writes nothing to disk and keeps nothing after answering.
- Only public market data is cached, in memory.
- **Forget my data** removes the export, the followed stocks and the settings from the browser.
- `.gitignore` keeps every `*.csv` out of the repo except `public/sample.csv`, which is made up.

## Data sources

- **Prices:** onvista's public API, no key. It resolves by ISIN and lists LS Exchange, the venue
  Trade Republic trades on, so prices match the app. Only EUR quotes are used. Unofficial: if it
  changes, the page says which instrument has no price instead of guessing.
- **News:** Google News RSS, searched by the company name from the export, last 7 days. A plain
  keyword search — generic names can pull in unrelated headlines.

## How the numbers are made

- Money in integer cents. In the export, `fee` and `tax` sit **outside** `amount`; cash moves by
  `amount + fee + tax`. `shares` is already signed (a SELL is negative).
- Cost basis is **FIFO** with order fees on both sides, as German tax law prescribes.
- **Earned in a month** = change in total value (cash + positions at month-end close) minus money
  paid in or out. It splits into interest, dividends, tax, fees, and price moves (the residual).
- **Tax pot** = interest + dividends (gross) + stock-sale gains. Stock losses only offset stock gains
  (Aktienverlusttopf), never interest. Above the allowance: 25 % + Soli (26,375 %), with church tax
  27,819 % (8 %) or 27,995 % (9 %). Single 1.000 € or joint 2.000 €, chosen on the Taxes tab.
- **Estimate to 31 Dec** = the last interest payment times the payments still to come, plus the
  dividend run-rate.
- **Crypto** is outside the pot (§ 23 EStG): tax-free after one year; sold sooner, gains under
  1.000 € a year are tax-free, at 1.000 € or more the whole gain is taxable.

Limits: this account only, assumes your exemption order (Freistellungsauftrag) is at Trade Republic,
no other capital income, no Vorabpauschale. An estimate, not tax advice.

## Layout

```
server.mjs          HTTP server + /api/{summary,news,quotes,search}, stateless
lib/portfolio.mjs   merge exports, FIFO lots, positions, months, tax
lib/market.mjs      onvista: ISIN -> LS Exchange quote, daily closes
lib/news.mjs        Google News RSS
lib/csv.mjs         CSV parsing, euro -> cents
public/index.html   the page - no build step, no framework
public/sample.csv   made-up transactions for the demo
scripts/check.mjs   offline checks
```

Not affiliated with Trade Republic.
