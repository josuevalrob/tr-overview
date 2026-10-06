# tr-overview

A depot overview for Trade Republic, built from its **transaction export**. Download it, run it on
your own machine, keep your data there. No account login, no database, no dependencies.

| Tab | |
|---|---|
| **Today** | every open position at the live LS Exchange price: today's move, value, paid, gain, weight |
| **Months** | what the account earned so far, stocks value vs cost, what each month earned, a month-by-month table |
| **Taxes** | the Sparer-Pauschbetrag used per year, an estimate to 31 Dec, "if you sold everything today", stock sales (FIFO), crypto holding periods |
| **News** | Google News headlines (English / German) for every holding, plus any stock you choose to follow |
| **Analysis** (click a position) | sidebar: 52-week range, financials (annual since ~2016 + EPS/dividend estimates; quarterly for US shares), analysts' buy/hold/sell and price targets, next earnings date, dividends |

## Run it

Node 20 or newer. Nothing to install.

```bash
git clone https://github.com/josuevalrob/tr-overview.git
cd tr-overview
node server.mjs            # http://localhost:3000   (PORT=8080 node server.mjs to change)
npm run check              # offline checks of the model against the sample
```

Open the page, then either **Try with sample data** (shown, never saved) or upload your own export.

## Getting the export

In Trade Republic: **Statements → Transaction export** (CSV). Export all time, or any range —
upload a fresh one whenever you like. Overlapping exports are merged by `transaction_id`, so
nothing is counted twice.

The monthly *Account statement* is a PDF with net amounts only (no fee, no tax) and is not read.

## Your data

- Uploaded exports are saved, untouched, in **`data/`** next to the app (`DATA_DIR=/some/folder` to
  move it). Followed stocks go to `data/watchlist.json`. Delete a file to undo an upload.
- `data/` is in `.gitignore`, as is every `*.csv` except the made-up `public/sample.csv` — your
  transactions can never end up in a commit.
- The server listens on `127.0.0.1` only. What leaves your machine: price requests to onvista (by
  ISIN) and news searches to Google News (by company name). Never your transactions.
- The browser only remembers view settings (tab, language, tax options).

## Data sources

- **Prices:** onvista's public API, no key. It resolves by ISIN and lists LS Exchange, the venue
  Trade Republic trades on, so prices match the app. Only EUR quotes are used. Unofficial: if it
  changes, the page says which instrument has no price instead of guessing.
- **Analysis:** onvista figures (all stocks; revenue derived as EBITDA ÷ EBITDA margin, net income as
  revenue × net margin) and Nasdaq's public API for US-listed shares only — analysts, price targets,
  earnings dates, quarterly results, dividend payments. Non-US tickers are never sent to Nasdaq, since
  the same symbol can be another company there. Trade Republic's derivatives long/short ratio is its own
  customer data and is not public.
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
server.mjs          local HTTP server: the page + /api/{summary,upload,preview,news,watchlist}
data/               your exports and followed stocks (git-ignored)
lib/portfolio.mjs   merge exports, FIFO lots, positions, months, tax
lib/market.mjs      onvista: ISIN -> LS Exchange quote, daily closes
lib/news.mjs        Google News RSS
lib/analysis.mjs    per-stock analysis: onvista figures + Nasdaq (US only)
lib/csv.mjs         CSV parsing, euro -> cents
public/index.html   the page - no build step, no framework
public/sample.csv   made-up transactions for the demo
scripts/check.mjs   offline checks
```

Not affiliated with Trade Republic.
