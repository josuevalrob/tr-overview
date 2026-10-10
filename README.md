# tr-overview

A depot overview for Trade Republic, built from its **transaction export**. Download it, run it on
your own machine, keep your data there. No account login, no database, no dependencies.

| Tab | |
|---|---|
| **Today** | every open position at the live LS Exchange price: today's move, value, paid, gain, weight; stocks + crypto over time (1W–All) beside today's line against yesterday's close; today's move by position (contribution in points, adding up to the total) beside a heatmap (a tile per position sized by its value, green / red by today's move); allocation by position, sector and country side by side (bars or pie); at the end, the price or the currency - a switch between the gain since bought (ECB rate on each buy day vs the latest) and today's move (live rate vs yesterday's close), each split per position into the price in its own currency and that currency against the euro |
| **Months** | return per year (money-weighted, everything or stocks only), what the account earned so far, stocks value vs cost, what each month earned, a month-by-month table |
| **Taxes** | the Sparer-Pauschbetrag used per year, an estimate to 31 Dec, "if you sold everything today", stock sales (FIFO), crypto holding periods |
| **News** | Google News headlines (English / German) for every holding, plus any stock you choose to follow; share of headlines per stock, biggest stories, similar headlines grouped |
| **Research** | any stock by name, ISIN or US ticker (`SE`): a read-out made from its numbers by fixed rules - price vs 52 weeks, trend (50- / 200-day average, this year, volume), beta, growth, profit, returns (ROE, ROA, margins), cash flow (free cash flow, buybacks), balance sheet (net cash, current ratio, debt/equity), valuation (P/E on last year and on estimates, P/S, P/B, PEG, expected EPS growth), **scenarios** a year out (bear / base / bull from analysts' targets, its own P/E range and its past 1-year returns, on one axis beside the score; a squeeze flag for US-listed shares heavily sold short), the company's **stage** (1 startup · 2 hyper growth · 3 operating leverage · 4 capital return · 5 decline - from revenue growth, profit and what it pays back) with the two yardsticks that fit it (forward price/sales + price/gross profit, or P/E + price/free cash flow), three investors' tests - **Graham** (Graham number √(22,5 × EPS × book value a share) + his defensive checks), **Buffett** (ROE, gross margin, debt vs profit, steady profit and free cash flow - he published no formula, so the checks commonly drawn from his letters), **Lynch** ((growth + dividend yield) ÷ P/E: under 1 poor, 1,5 okay, 2 what he looked for), **Ackman** (Pershing Square's measurable criteria: free cash flow every year, revenue up every year, operating margin, debt vs free cash flow, free-cash-flow yield), analysts, insiders (sales / buys, trading plans), short interest, funds (13F holders added / cut), next results, what this week's headlines are about, dividend, listing currency - in five groups (Price · Business · Valuation · Who's buying · Good to know). **Funds and ETFs** get their own group instead: costs (TER), fund size, index and how it is held (full, sample, swap), return against the index, returns by year, top 10 holdings (and which of them you already hold), countries, sectors (both also as rings, the smallest folded into Other), currencies, **gains & losses** (each calendar year's change as a column; bought on any day and held 1, 3 or 5 years - the share of days that ended with a gain, worst / middle / best of 1.000 €, and a histogram of what 1.000 € became, payouts reinvested), payouts over 12 months, German Teilfreistellung, one headline number per row and the full sentence (and an investor's ✓ / ✗ checks) on click, each green / red / grey with its rule under "?"; a slider from 0 to your cash for what a buy does to the depot - weight, largest position, share in US dollars, and the share by position, sector or country (toggle) before → after - a fund split by what it holds, live while you drag; the track turns red where the stock passes 25 % of the depot; this week's stories. **Company numbers**: what the company reports in its own quarterly results and no feed has (Sea: Shopee GMV, take rate, loan book, NPL…), last 4 quarters with the change on a year before, your own green / red lines, "update due" once newer results are out; beside it a small bar chart per number over every saved quarter. **Company file**: what no feed has for it - the contracts it announced, who runs it (since when, pay, shares held), insiders' and politicians' trades, disclosed holders, analysts' ratings and targets, events past and coming - one section at a time, every line with its source; the read-out takes analysts (also for Up / down and the scenarios), insiders (open market only), politicians, contracts of the last 12 months, holders, the CEO and the next results date from it where no feed has them (a European share has no Nasdaq analysts or Form 4s). Suggestions while you type: name, ISIN, where it trades in the US (NYSE: ONON), the ISIN or US ticker you typed marked "exact". **Follow** on the read-out puts a stock in News too; **☆ Favorite** stars it (a stock neither held nor followed gets followed too), ★ on its chip, and the chips' switch (All · ★ Favorites · Sector · Country · Currency · Score · P/E · Stage - each stage cheapest first on its own yardstick) puts the starred ones first |
| **Analysis** (click a position) | sidebar: price chart (1M–5Y) with your buys and sells marked, 52-week range, financials (annual since ~2016 + EPS/dividend estimates; quarterly for US shares), analysts' buy/hold/sell and price targets, next earnings date, dividends. **Compare with…** another stock: the two lines on top of each other - price and revenue since the same start (log scale), EBIT margin, P/E over time with each one's median - then five numbers side by side (score, forward P/E, price/FCF, dividend yield, equity ratio), the better one green |

## Run it

Node 20 or newer. Nothing to install.

```bash
git clone https://github.com/josuevalrob/tr-overview.git
cd tr-overview
node server.mjs            # http://localhost:3000   (PORT=8080 node server.mjs to change)
npm run check              # offline checks of the model against the sample
```

Open the page, then either **Try with sample data** (shown, never saved) or upload your own export.

## For agents (MCP)

`mcp.mjs` is an MCP server over stdio, so Claude Code, Claude Desktop or any MCP client can work with
the same depot — no web server needed, no dependencies.

```bash
claude mcp add tr-overview -- node /absolute/path/to/tr-overview/mcp.mjs
```

| Tool | |
|---|---|
| `overview` | value, paid, gain, today's move, cash, total, return per year, export freshness — start here |
| `positions` | every position with live price, today, value, gain € / %, weight, sector, country |
| `performance` | result over 1W / 1M / YTD / 1Y / All, optionally the daily series |
| `today_intraday` | today's recorded line against yesterday's close |
| `months` | month-by-month table, return per year |
| `taxes` | Sparer-Pauschbetrag for a year, estimate to 31 Dec, sell-all scenario, sales, crypto (joint / church tax options) |
| `stock_analysis` | financials, analysts, events, dividends + your position and trades — stock by name or ISIN |
| `company_numbers` | read or add a company's own quarterly figures (data/kpis/), set your green / red lines |
| `company_file` | read, add or remove what no feed has: contracts, people, insiders' and politicians' trades, holders, analysts' ratings, events (data/dossier/) |
| `research` | the Research tab for one stock, optionally with an amount in € to buy - start here to talk about a stock |
| `price_history` | daily closes with your buys and sells |
| `news` | headlines for holdings, followed stocks, or one stock |
| `watchlist` | list / add / remove followed stocks, favorite / unfavorite (the ★ on Research) |
| `reminder` | a results-day event with alerts in your calendar (macOS Calendar; elsewhere an .ics in data/reminders/), list / remove |
| `search_instrument` | find a stock, ETF or crypto |
| `import_export` | import a Trade Republic CSV from a file path |

Stocks can be named loosely ("uber", "meta"). Amounts are euros.

## Getting the export

In Trade Republic: **Statements → Transaction export** (CSV). Export all time, or any range —
upload a fresh one whenever you like. Overlapping exports are merged by `transaction_id`, so
nothing is counted twice.

The monthly *Account statement* is a PDF with net amounts only (no fee, no tax) and is not read.

## Your data

- Uploaded exports are saved, untouched, in **`data/`** next to the app (`DATA_DIR=/some/folder` to
  move it). An older export whose every row is in the new one is replaced, so a fresh "all time"
  export leaves a single file. Followed stocks go to `data/watchlist.json`, starred ones to `data/favorites.json`, results-day reminders to `data/reminders.json`, company numbers to `data/kpis/`, company files to `data/dossier/`. Delete a file to undo an upload.
- Nothing else is stored: prices, history, analysis and news live in memory and are gone on restart.
- `data/` is in `.gitignore`, as is every `*.csv` except the made-up `public/sample.csv` — your
  transactions can never end up in a commit.
- The server listens on `127.0.0.1` only. What leaves your machine: price requests to onvista (by
  ISIN), ISINs to OpenFIGI (for their US ticker), company data requests to Nasdaq and FINRA (by US
  ticker, US-listed shares only) and news searches to Google News (by company name and US ticker).
  Never your transactions.
- `data/intraday.json`: today's depot value, recorded every minute while the page is open and every 5
  minutes otherwise (onvista does not serve intraday charts to scripts). Started fresh each day; the line
  covers only the hours the server ran.
- The browser only remembers view settings (tab, language, tax options).

## Data sources

- **Prices:** onvista's public API, no key. It resolves by ISIN and lists LS Exchange, the venue
  Trade Republic trades on, so prices match the app. Only EUR quotes are used. Unofficial: if it
  changes, the page says which instrument has no price instead of guessing.
- **Analysis:** onvista figures (all stocks; revenue derived as EBITDA ÷ EBITDA margin, net income as
  revenue × net margin; return on equity, equity ratio, P/B, P/CF, PEG, beta against its benchmark index,
  volatility) and Nasdaq's public API for US-listed shares only — analysts, price targets,
  earnings dates, quarterly results, fiscal years as reported with balance sheet and cash flow (onvista can
  lag: Sea Limited ends in 2023 there), market value, volume, EPS consensus, PEG, dividend payments,
  insider trades (3 / 12 months), institutional holders (13F). Short interest: FINRA's public API (no key),
  twice a month, US-listed shares only. Matching is by ID, not by name: OpenFIGI (no key, 25
  requests a minute) gives an ISIN's US ticker and exchange - NYSE or Nasdaq, not OTC - so a Swiss
  share on the NYSE (On, ONON) gets its US data, and a home symbol is never sent to Nasdaq, where it
  can be another company. A ticker typed in the search ("onon", "SE") is looked up on Nasdaq for its
  company name, searched on onvista, and the hit whose ISIN has that ticker is the exact one.
  Trade Republic's derivatives long/short ratio is its own
  customer data and is not public.
- **News:** Google News RSS, searched by the company name from the export and, for US-listed shares,
  "NYSE:ONON" - last 7 days, one query per day (Google lists at most 100 per query; a busy stock still
  hits that, shown as "+"). Google matches words anywhere in the article, so only headlines that name
  the company (its first word, or the whole name when that is short: "On Holding") or its ticker are
  kept. Headlines are grouped into stories
  without a model: same stock, within two days, sharing their rare words (tf-idf cosine).

## Company numbers

What a company reports in its own quarterly results and no free feed has (GMV, loan book, ...). They are
data, so they live in `data/kpis/<ISIN>.json`, git-ignored like everything in `data/`: add them in the
Research tab (Edit) or let an agent do it through the MCP tool `company_numbers`. Each quarter keeps the
values as printed in the release, its link (`source`) and date (`reported`); optional `changes` hold the
year-on-year change the release states, since releases round. Your green / red lines: `data/kpi-lines.json`.

## Company file

What no free feed carries for a company - above all a European one, which has no Nasdaq analysts, Form 4 insider
trades or 13F funds: contracts it announced, who runs it, insiders' and politicians' trades, disclosed holders,
analysts' ratings and targets, events (results days, deals, guidance, legal). Data, so it lives in
`data/dossier/<ISIN>.json`, git-ignored: let an agent fill it through the MCP tool `company_file`, or edit a section
as JSON in the Research tab. Every item keeps its `source` link; one item per key (a contract by date + customer +
what, a rating by date + firm ...), so saving it again replaces it. The read-out uses it only by fixed rules: each
firm's latest rating of 12 months, open-market insider trades (grants and plan trades left out), contracts of the
last 12 months (acquisitions and investments are not "won"), the first results event from today.

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
server.mjs          local HTTP server: the page + /api/*
mcp.mjs             MCP server (stdio) for agents
lib/app.mjs         everything the app does over the data folder - shared by both
data/               your exports and followed stocks (git-ignored)
lib/portfolio.mjs   merge exports, FIFO lots, positions, months, tax
lib/market.mjs      onvista: ISIN -> LS Exchange quote, daily closes
lib/news.mjs        Google News RSS
lib/analysis.mjs    per-stock analysis: onvista figures + Nasdaq (US only)
lib/figi.mjs        OpenFIGI: ISIN -> US ticker and exchange
lib/kpis.mjs        company numbers (data/kpis/): validate, merge, last 4 quarters + change, lines
lib/dossier.mjs     company file (data/dossier/): validate, merge by key, the brief the read-out uses
lib/research.mjs    the Research read-out and "if you buy": fixed rules over the analysis, prices, news
lib/csv.mjs         CSV parsing, euro -> cents
public/index.html   the page - no build step, no framework
public/sample.csv   made-up transactions for the demo
scripts/check.mjs   offline checks
```

Not affiliated with Trade Republic.
