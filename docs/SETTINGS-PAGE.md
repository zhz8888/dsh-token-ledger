# The settings page

English | [中文](SETTINGS-PAGE.zh.md)

[← Back to the README](../README.md)

## Settings page

The browser half adds a **Token ledger** section to the settings sidebar. At the
top it carries a view switcher in the host's own plugin-market shape — a rounded
track with the selected view's card on it, the card sliding to the next view —
and three views: **Overview**, **Rates** and **Bill**. The switcher takes the
arrow keys as well as the pointer, and only the selected view is a tab stop.

Its own labels are registered with the host's locale service, so they follow the
host's language.

### Overview

- **Range totals** for this month, this year, the last 7 days and **all of it** —
  total tokens, cache hit rate, call count, **Est. cost** and the
  four-bucket breakdown behind them. *All* is every day the ledger holds, starting at its
  first day. The cache hit rate is `cacheRead / (cacheRead + uncachedInput)`: the
  share of input the prompt cache absorbed, so a route with no caching reads 0%
  rather than undefined.
- **The estimated cost is the bill's own arithmetic**, computed on the host for each
  of the overview's periods, so the number under *this month* and the bill's month
  are the same number rather than two estimators that agree today. It is shown in
  yuan to two decimals, with the rate it converted at. A host that has no prices yet
  shows a dash and says why instead of a confident `¥0.00`, and tokens the bill could
  not price are named underneath the number they are missing from.
- **Today, live** — today's tokens, hit rate, calls and cost, refreshed once a
  minute.
- **A usage calendar** switchable between year, month and week. Year and month are
  heatmaps; the week view is one horizontal bar per day. Heat levels are relative
  to the busiest day in the window and square-rooted, so one huge day cannot
  flatten the rest. The month view also carries a summary beside the grid: the
  busiest day, the lightest weekday and the weekday that ran latest (compared by
  the clock time of the day's last call).
- **Per model** totals, each with its own hit rate and a stacked bar showing where
  the tokens went, with a key naming each bucket that appears. A bucket with no tokens
  anywhere — cache writes, on vendors that publish no cache-write price — is left out
  of the bar and the key rather than being a colour nobody can find in a bar.

### Rates

- **The USD/CNY rate** in its own box, to four decimals, with its source and how
  long ago it was fetched. This tab is a price list: it states prices and converts
  them for display, and says on the page that the cost arithmetic lives on the
  **Bill** tab, where it is applied to the ledger.
- **Each vendor's newest models**, two to three per vendor, with the published
  price per million tokens for input, output, cache read and cache write. A USD
  price is converted into yuan with the rate above; every converted cell keeps the
  dollar quote it came from in its tooltip, and with no rate fetched the table falls
  back to USD and labels its column in dollars rather than printing a number it
  cannot stand behind. A price the vendor does not publish is a dash, which is a
  different claim from "free", and a published `0` is flagged as *not necessarily
  free* because some platforms bill by the hour and publish no per-token price.
- **A model the source marks as retired does not take a slot, and keeps its
  price.** The price list marks the models a vendor no longer sells — `gpt-4-turbo`,
  `MiniMax-M2.7`, half of Qwen's list — and they do not take one of the vendor's
  slots, because otherwise DeepSeek's "newest three" are two retired models and
  MiniMax's eight are six. They **keep their price**, because that is what the
  calls that were made were billed at, and the row says it is retired. A model
  the source lists under two names — `gemini-flash-latest` beside
  `gemini-3.7-flash`, at the same price and released the same day — counts once,
  or one model would take two of the few slots a vendor has.
- **Every vendor can be expanded to all of its models.** The table lists each vendor's
  newest two or three by default, and the number beside the vendor's name is how many
  models it has in all. The ▸ at the right of the vendor's header expands that group to
  **every** model the catalogue carries, and pressing it again collapses the list
  again. The expanded list is fetched from the host when it is asked for
  (`GET /api/token-ledger/rates?vendor=…`), so a reader who never expands one never
  pays for those rows. When the fetch fails the page says so and keeps the rows it
  already had, and a price edited inside an expanded list is saved like any other —
  the open list is fetched again afterwards, so it never shows a stale number.
- **Prices come from where the vendors publish them.** None of these vendors
  exposes prices through an API — their model-list endpoints return ids and no
  money, so the number only exists on their pricing page. Where that page can be
  read, it is: **DeepSeek, Z.ai and Tencent** are priced from their own pages, and
  their group carries a `vendor` badge — the mark that says this price came from the
  vendor itself. The rest come from a per-vendor
  public dataset ([models.dev](https://models.dev)); `rates.source: openrouter`
  switches the whole table to that gateway's own quotes, which cover more models but
  are not the vendors' list prices. The page says which is which, because those are
  different claims.
- **DeepSeek shows peak and off-peak separately.** Its page prices two models in
  yuan across cache-hit input, cache-miss input and output, each with a peak and an
  off-peak column — off-peak being half of peak outside 09:00–12:00 and 14:00–18:00
  Beijing time on weekdays. Each period is its own labelled row, and the window is
  quoted from the vendor's own page. A vendor that publishes in yuan is displayed in
  yuan, unconverted.
- **The twelve vendors worth listing**, each with its own mark drawn inline from
  bundled geometry: OpenAI, Anthropic, Google, DeepSeek, Qwen, xAI, Z.ai, Kimi,
  MiniMax, Tencent, Xiaomi and ByteDance. The marks are the official ones — taken
  from the vendors' own sites or from Simple Icons — and are the trademarks of their
  owners, used to identify whose price is shown. A vendor outside this list still
  gets a mark and a place when a source carries it; `rates.vendors: 0` publishes
  every vendor.
- **Hand entry.** Any price, and the rate itself, can be typed over — in the
  currency the table is showing. A typed value outranks every later fetch, and a
  row whose number actually changed is marked as hand-entered; typing the value
  the fetch already produces leaves the row unmarked, since a refresh would not
  change it. Either way the row can be handed back to the fetched value or
  cleared. There is also a free-form entry row for a model that no fetch has
  described.
- **Refresh on demand, then settle each disagreement.** A button on the prices
  card runs the same fetch the timer would, without waiting up to half an hour
  for it; a fetch that could not reach a source says so instead of reporting a
  save. When the official price for a model you typed over has moved, the model
  is listed on its own with both numbers and one question — use the official
  price, or keep yours. "Use official" deletes the typed value, handing the field
  back to the catalogue rather than freezing it at today's number; "keep mine"
  records the official number that was on screen, so the same disagreement is
  not raised again until the catalogue actually moves.
- **Offline is a state, not an error.** The host refreshes prices and the rate
  every 30 minutes. A failed refresh keeps the last good result and reports the
  attempt as failed, so a firewalled machine sees the last known prices with a
  visible age rather than a blank page. A host that has never reached the network
  says so and points at the hand-entry form; a host configured with
  `rates: false` makes no request at all and is a price list you maintain.

### Bill

The same usage, grouped the way a bill is read. **Four groupings are stacked** —
workspace, session, model, vendor — rather than put behind a tab, because the
question a bill answers is usually comparative, and **each section carries its own
period**, so this month by workspace can sit above today by model.

- **The bill prices from the whole catalogue, not from the rows the table shows.**
  The price list publishes each vendor's newest few models, but the ledger
  records the models you actually called — a call to `gpt-4o` or `MiniMax-M2.7`
  is priced from the catalogue like any other rather than left unpriced. A
  retired model is in that catalogue too, at the price it was billed at.
- **What each row shows**: the group, **the cost** (`Cost`), cache-read input
  (`Cache read`), the input that missed the cache (`Uncached input`), output, the cache hit
  rate, and the call count. The two input columns are separate because they are priced
  differently on every vendor that prices them at all; cache-write input is stated
  under each table rather than as a column that would be a dash nearly everywhere.
- **Names that mean something**: a workspace row is the `cwd` the ledger recorded for
  the sessions that ran there; a session row reads `workspace/session-name`, using the
  title DSH itself gave the session (falling back to the session id for sessions DSH
  never titled, with the full id and path in the tooltip); a model row reads
  `provider/model` — the route the ledger recorded, the same name the overview's model
  list shows — with the price row it was billed at in the tooltip.
- **A vendor row is a provider you connected, not a price list.** `bos`, `qwen-plan`,
  `deepseek-official` and `zai` are endpoints; `deepseek`, `qwen` and `z-ai` are whose
  list prices their tokens carry. The row shows the provider — under the display name
  the model settings page gives it, so `BOS-API` rather than `bos`, read from the
  harness settings file and never written to it — and states the price source
  underneath (`priced from deepseek`). Two endpoints serving the same model are therefore
  two rows, which is the question a vendor bill exists to answer.
- **Five periods per section**: this month, this year, the last 7 days, today, or
  everything, using the same trailing-window definitions as the overview.
- **The session list is summarised; the file is not.** A session asked once and archived
  is a row that says nothing, and a machine collects hundreds of them, so the sessions
  that are **cheap or barely used — under ¥1, or fewer than 10 calls** — stand in one
  line on the page (`{n} other low-cost sessions`, badged `summed`, with their columns
  summed). The total does not move: the rows still add up to it. A note under the table
  says how many were summarised and what the rule was, and **the export always lists
  every session** —
  `format=csv` is the complete record. Two things are never folded: a session whose
  tokens could not be priced, and a list where every row qualifies.
  `bill.smallSessionCost`, `bill.smallSessionCalls` and `bill.foldSmallSessions: false`
  change the rule or turn it off. Only the session dimension folds.
- **One export for all of it, top right.** CSV or JSON, carrying every grouping over
  every period, with the currency on every row and **one `TOTAL` per section**. There
  is deliberately no grand total: the periods overlap, and adding today to this week
  to this month would count the same tokens four times. The CSV starts with a UTF-8
  byte-order mark, without which Excel opens it in the system code page and a session
  named `编写统计` arrives as `缂栧啓缁熻`; the JSON export has none, because a JSON
  parser rejects a leading mark.
- **By plan, without double counting.** `subscriptions` in the config takes monthly
  plans, and the fee is spread over the days the bill covers: the 1st-to-10th of a
  ¥199 month is ¥66.33, not ¥199. A vendor on a plan is billed its plan and the usage
  it covers is shown beside it rather than added to it, because adding them would
  charge for the same calls twice. Because a plan is one charge, on a grouping where
  its vendor appears in several rows — workspaces, sessions, models — the plan is
  *allocated* across those rows in proportion to the usage it covers, which is what
  makes a section's rows add up to its total. A row billed partly by plan says so
  (`of which plan`), and a plan whose vendor has no usage in the period is still billed,
  because it was still paid for. A plan's `vendor` may name either the provider or the
  price vendor (`bos` or `deepseek`); both resolve to the usage the plan covers.
- **What it could not price is listed, not charged at zero**: each unpriced model
  with its tokens, calls and the reason — no price for that model, an ambiguous name
  that two vendors both publish, or a price in a currency the bill cannot convert.
  Prices joined by name rather than by id are listed too, so a join can be checked
  rather than trusted.
- **A time-priced vendor is billed per side of its window.** DeepSeek prices peak
  and off-peak differently, and the ledger records which calls fell inside the
  window — 09:00–12:00 and 14:00–18:00 on weekdays, Beijing time — so the two are
  priced at their own rates instead of being charged at one of them.
- **The bill is an estimate, and says so.** It multiplies the tokens the session log
  recorded by the published list price of the model the route named. It makes no
  claim about what a provider invoices, which differs for failed, retried and
  partially delivered requests, and it does not know about a plan's included quota
  beyond what you tell it in the config.

The page reads four loopback-only routes: `GET /api/token-ledger/summary` for the
overview, `GET|POST /api/token-ledger/rates` for prices and the rate,
`GET /api/token-ledger/bill` for the bill, and `GET /api/token-ledger/i18n` for the
page's own text. Expanding a vendor to all of its models reads the same rates
route with the vendor named: `GET /api/token-ledger/rates?vendor=<vendor>`. The
overview polls once a minute, prices and the bill only while their view is open.
All four refuse a non-loopback peer, so they stay private even if the web server
is bound to `0.0.0.0`. The write half additionally requires a JSON content type —
a cross-origin form cannot send one — and caps the body at 256 KiB.

**The texts are data, not code.** The Chinese and English entries live in
`locale/zh.json` and `locale/en.json`; the host reads them and serves them over
the route above, and the browser hands them to the locale service. The two
languages carry the same key set — a key missing from one of them means a reader
gets a word in one language and the key itself in the other — and a test says so.
The browser half is one classic script and cannot carry files of its own, so this
is how the words reach it; when they cannot be read the section still appears and
its labels fall back to the keys.

It needs a profile with a web server (the `web` or `desktop` profile). Without one,
`/tokens` and the CLI still work, and the section says so instead of failing. Note
that hand-entered prices are entered **on that page**: there is no command-line
equivalent yet, so a headless profile can read the usage ledger but cannot type a
price.

None of the three views is published through a settings namespace. That would need a schema —
a real dependency, and this package has none — and would rewrite `settings.yaml` on
every debounce with data that is derived and reproducible. The ledger file stays the
only store of record; prices live in `rates.json` beside it.


---

## More documents

- [How the numbers are counted](COUNTING.md) — the counting rules, forks versus resumes, and the audit
- [The settings page](SETTINGS-PAGE.md) — the three views in full
- [Configuration](CONFIGURATION.md) — every key the plugin reads
- [Compatibility](COMPATIBILITY.md) — which DSH it needs, and what it touches
- [Development and releasing](DEVELOPMENT.md) — working on the plugin, and publishing it
- [Verification](VERIFICATION.md) — what was actually checked, and what was not
- [All documents](README.md) — the index
