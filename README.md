# Darbar Sahib Hukamnama Archive

A daily record of which shabad was read as the Hukamnama (Mukhvaak) at **Sachkhand Sri Harimandar Sahib, Sri Amritsar**, published as small JSON files of Shabad OS shabad IDs.

> **Unofficial.** This project is not affiliated with, endorsed by, or connected to Sachkhand Sri Harimandar Sahib, Sri Amritsar or the Shiromani Gurdwara Parbandhak Committee (SGPC), and it is not affiliated with HukamnamaSahib.com. It is an independent, community-maintained record. If SGPC or the sangat would prefer this not exist, write to the address in [Contact](#contact) and it will be taken down without argument.

## What this is

SGPC publishes the daily Hukamnama from Sri Guru Granth Sahib Ji as an ordinary web page, with no developer-facing endpoint. SGPC's site answers GitHub's servers with 403, so the daily job reads [hukamnamasahib.com](https://hukamnamasahib.com)'s morning page instead, a mirror of SGPC's daily hukamnama. It works out **which shabad** the reading is and records the identifier. SGPC's own archive remains the reference the resolver and the mirror are measured against (see [Measured results](#measured-results)).

**No Gurbani text is published in `archive/`.** Only pointers. Clients look the shabad up in their own copy of the corpus.

Coverage: from the first day the daily job publishes. There is no backfill.

## Usage

Files are served straight off GitHub's CDN. There is no server, no API key, and no rate limit worth worrying about.

`archive/latest.json` always holds the most recently published day, so a client that just wants "the current hukamnama" doesn't need to construct today's date or handle a 404 for a day that hasn't published yet:

```
https://raw.githubusercontent.com/Harkie21/darbar-sahib-hukamnama-archive/main/archive/latest.json
```

**Check the `date` field rather than assuming it is today.** The cron can run hours late, the source posts some time after the reading, and some days publish nothing at all. `latest.json` then still points at the last day that *did* resolve, rather than being empty or missing, but that means `date` can be yesterday's or older.

Individual days are addressable directly:

```
https://raw.githubusercontent.com/Harkie21/darbar-sahib-hukamnama-archive/main/archive/YYYY/MM/DD.json
```

```bash
curl https://raw.githubusercontent.com/Harkie21/darbar-sahib-hukamnama-archive/main/archive/2026/10/14.json
```

```json
{
  "date": "2026-10-14",
  "source": "darbar_sahib",
  "shabad_ids": ["DWV"],
  "sggs": {
    "shabad_ids": ["DWV"],
    "line_ids": ["3DN5", "93FA", "SKK7", "DVU4", "UEQS", "4ZNG", "MXVC", "D2FX", "3MK3", "V8M1"],
    "confidence": "high",
    "score": 1,
    "margin": 0.574,
    "ang": 598,
    "ang_delta": 0,
    "counters": [1, 2, 3, 4]
  },
  "dsg": null,
  "corpus": { "name": "@shabados/database", "version": "4.8.7" }
}
```

The schema is identical to [`hazur-sahib-hukamnama-archive`](https://github.com/Harkie21/hazur-sahib-hukamnama-archive): same keys, same order, same types. Only `source` differs, and `dsg` is always `null`. The key is kept so a client reading both archives needs one code path.

Dates are **IST**. The hukamnama is read at Amritsar, so its day boundary governs.

The top-level `shabad_ids` mirrors [`gurbaninow/hukamnama-archive`](https://github.com/gurbaninow/hukamnama-archive), so a client written for that format works here unmodified.

A missing file means the day has not been published, or the resolver declined to guess. **404 is a normal state; handle it.**

> **Partial readings.** On some days the source publishes only the opening part of a long or multi-shabad reading. On those days `shabad_ids` and `line_ids` list only what it shows. The first shabad is always the start of the reading (measured: 14 of 160 days were partial, 0 started on the wrong shabad). The first line is always the start of the reading (measured: 0 days started on the wrong line). This differs from the Hazur Sahib archive, where `shabad_ids` covers the full reading.

### `confidence`

| Value | Meaning | What a client should do |
|---|---|---|
| `high` | accepted, and 85% of the reading's lines matched at score ≥ 0.88, with every counter in the passage found | Link into your library |
| `medium` | accepted on weaker evidence than that | Link, but worth logging |
| `low` | not accepted | `shabad_ids` is empty. Render nothing, or the source text read-only. **Never guess.** |

This archive never writes a low file: when the resolver declines, the day is a 404.

`confidence` describes how sure the match is, not whether the source showed the whole reading. A partial day can be `high`.

A resolution is *accepted* when 60% of the reading's lines matched, the average score is ≥ 0.72, the ang veto did not fire, and either `margin` ≥ 0.25 or the passage carries a counter rare enough to anchor it on its own.

`margin` (the gap to the runner-up) is the load-bearing signal, not `score`. Edition differences depress absolute similarity fairly uniformly; they do not create rival candidates. The thresholds themselves live in `THRESHOLDS` in `lib/resolve.js`, each with the measurement that set it.

### `line_ids`

Amritsar's reading unit and Shabad OS's shabad boundary do not always align. On 2026-01-29 the reading covered about a tenth of shabad `9RZ` before running into `X3Y`; on 2025-04-27 it covered half of `68X`. `shabad_id` alone can therefore name a superset of what was actually read. Clients that want to display or highlight exactly what was read should bound it with `line_ids`, not just the shabad ID.

## How resolution works

1. Read the hukamnamasahib.com morning page: heading, bani and the cited ang (already Unicode Gurmukhi on the source page).
2. Canonicalise: drop the mangal, counters, danda, vishraam marks, addak, nukta, and all whitespace.
3. Score Sørensen-Dice over character bigrams against every Sri Guru Granth Sahib Ji shabad in Shabad OS `@shabados/database@4.8.7`.
4. Accept only on a wide margin over the runner-up, subject to the ang veto and contiguity rules below.

The resolver is the Hazur Sahib one, copied rather than shared, with one addition: the ang cited on the page is passed in directly instead of being extracted from the bani text. A parity test checks that 200 seeded shabads resolve identically to the Hazur Sahib resolver.

### Matching happens in Unicode, never ASCII

The `lines.gurmukhi` column in `@shabados/database@4.8.7` is **visual-order ASCII** (AnmolLipi / GurbaniAkhar): the sihari glyph precedes its consonant. `gurmukhi-utils.toUnicode()` performs the visual-to-logical reorder, but `toAscii()` does **not** reproduce that column going back the other way; it is not a round trip.

Converting a scrape down to ASCII to match therefore fails quietly. Measured on 2026-08-26 for Hazur Sahib: a shabad that should score 1.000 scored **0.855**, with the diff isolated to sihari placement (`riMgihr` vs `rMighir`). Converting the corpus **up** to Unicode instead scores 1.000.

### Ang is a veto, never a key

An ang holds several shabads (3 begin on ang 711, 8 touch ang 550), so ang alone can never *select* a match. But it does reject:

- **`|ang_delta| > 50` is rejected.** No edition disagrees by fifty pages, so a gap that large is ground truth that a match is wrong regardless of how well the text scores. On the Hazur Sahib archive, before this check was added, 36 such matches scored up to 1.000 and were graded `high`.
- **`ang_delta < -1` is rejected.** This follows from how the hukamnama is taken: the granth is opened, reading begins at the top of the left-hand page, and if a shabad is already in progress there the reader turns back to its heading. So a shabad's *start* ang is always at or before the ang cited on the page, and a negative delta (start ang after the cited ang) cannot happen.
- **A cited ang more than 1 past the reading's *last* ang is rejected.** The mirror image of the rule above, and the same physical fact: the cited ang is a page the book was actually open at, so the reading cannot have ended well before it. Expressed against the last ang rather than as a flat delta because a shabad may span up to 9 angs and be cited from any of them.

These rules apply to Sri Guru Granth Sahib Ji only, which is all Amritsar publishes. On the 160 validation days `ang_delta` was 0 on 159 and +1 on one, and `cited − last ang` was -1 or 0 on every day (histograms under [Measured results](#measured-results)).

`ang_delta` (scraped − corpus) is recorded on every entry so the drift can be tracked over time.

### The counter override has to earn its keep

A passage's chhand counter can stand in for `margin`, but only when it actually narrows the field. In Sri Dasam Granth `੧੪੭੨`, `੧੫੯੬` and `੧੫੯੭` each sit on **one line** in the whole granth, which is why the override exists at all. In Guru Granth the counter `੧` sits on **6,043** lines and `੨` on 3,523; agreeing on one of those is not evidence of anything.

So the override requires the rarest counter in the passage to sit on **at most 8 lines** of that granth. Without this, a perfect tie between two textual duplicates scored 1.000 with `margin` 0.000 and was published as `high` on the Hazur Sahib archive: the `ਗੁਰਦੇਵ ਮਾਤਾ` salok, which both opens (`K26`, ang 250) and closes (`YLS`, ang 262) Bavan Akhri. On the 160 Amritsar validation days the override rescued nothing.

### Exact ties are broken by ang, not by luck

Where the granth genuinely repeats itself, two corpus lines score *identically* and text cannot choose between them. The cited ang can, so a tie at exactly equal similarity goes to the candidate whose start ang is consistent with the ang on the page. This only ever picks between candidates that already scored the same, and it does not touch `margin`: a duplicate still has to clear the margin gate on its own, and is refused if it cannot. Refusing a tie is acceptable; guessing is not. On the Amritsar validation days the tie-break decided 2 days (2026-07-04 and 2026-07-05).

### Multi-shabad readings must be contiguous

A genuine multi-shabad hukamnama is adjacent in the granth: a vaar is salok + salok + pauri in sequence. Because Gurbani reuses phrasing heavily, stray lines can otherwise match unrelated shabads elsewhere in the corpus. On the Hazur Sahib archive one recurring pair (Tilang M5 at ang 724 chaining to Ramkali M5 at ang 894, 552 shabads apart) showed up 20 times before contiguity was enforced. Amritsar reads multi-shabad passages often: 59 of the 160 validation days, matching gurbaninow exactly on every one (the date list deliberately over-samples them).

## Measured results

### SGPC validation

160 days of the SGPC archive, compared with `gurbaninow/hukamnama-archive` by `bin/validate.js`. Ids and numbers only. The full report is [validation/report.md](validation/report.md).

| class | days | share | high | medium | low |
|---|---|---|---|---|---|
| AGREE | 159 | 99.4% | 156 | 3 | 0 |
| SUPERSET | 1 | 0.6% | 1 | 0 | 0 |

**0 known-wrong, 0 refused.** Every day graded `high` or `medium`.

The one disagreement is **2025-05-21**: ours `DY5+2BT+GVP`, gurbaninow `2BT+GVP`. Every line of all three shabads is on the SGPC page, so gurbaninow is missing a shabad that was read. It is attributed to the reference, which on recent days appears to come from its SikhNet fallback.

Needs review (not auto-classified):

- **2025-04-27**, `68X`: a partial reading. Half of the shabad's lines are on the page; both archives include it.
- **9KD**, on 5 days of the same eight-shabad reading: adjacent to the reading but not read (a third of its lines appear on the page). Neither archive includes it.

`ang_delta` (cited − corpus start ang):

| delta | days |
|---|---|
| 0 | 159 |
| +1 | 1 |

`cited − last ang` of the reading:

| value | days |
|---|---|
| -1 | 52 |
| 0 | 108 |

`margin`: n=160, min 0.273, p05 0.36, median 0.497, max 0.658. Nothing lands between 0.273 and 0.335; `minMargin` is 0.25.

| band (lower edge, width 0.05) | days |
|---|---|
| 0.25 | 1 |
| 0.30 | 4 |
| 0.35 | 8 |
| 0.40 | 21 |
| 0.45 | 53 |
| 0.50 | 38 |
| 0.55 | 33 |
| 0.60 | 1 |
| 0.65 | 1 |

Thresholds: HS values retained. On 160 Amritsar days none refused a correct reading; Amritsar produced no incorrect candidates, so the lower bound is untested here.

### hukamnamasahib.com cross-check

The same 160 days read from the hukamnamasahib.com morning page and compared with SGPC's own page for that day by `bin/crosscheck-hns.js`, both through the same resolver. Ids and numbers only. The full report is [validation/hns-crosscheck.md](validation/hns-crosscheck.md).

| class | days | meaning |
|---|---|---|
| EQUAL_IDS | 141 | same `shabad_ids` and `line_ids` as SGPC |
| PREFIX | 14 | the source showed only the opening part; both id lists are a leading prefix of SGPC's |
| START_WRONG | 0 | first shabad differs from SGPC's |
| OTHER | 0 | any other relation |
| REFUSED | 3 | would publish nothing (2025-04-14 and 2026-09-10 show only 4 lines, too few to beat the runner-up; 2026-06-22 cites the wrong ang) |
| MISSING | 2 | no morning page with text (2025-06-05, 2025-10-12) |

**START_WRONG = 0.** On all 155 days that would publish, the first shabad and the first line equal SGPC's.

## Known quirks in the source

hukamnamasahib.com (the daily source):

- SGPC's site answers GitHub's runners with 403, which is why the daily job reads the mirror.
- The morning page is `https://hukamnamasahib.com/hukamnama/YYYY-MM-DD-morning`. The same date also has `-evening` and, on sangrand, `-sangrand` pages. Only a page whose slug, category and title all say morning is accepted; anything else is refused as the wrong session.
- Each page embeds `relatedPosts`, the full text of other days' readings. Only the main reading block is read, never `relatedPosts` or the "More Hukamnamas" list.
- A day that does not exist yet returns HTTP 200 with a not-found page, not a 404. It is treated as "not yet".
- Some days show only the opening part of a long or multi-shabad reading (see [Partial readings](#usage)).
- On 2026-06-22 the page cited ang 522 for a reading that starts at ang 592. The ang veto refuses it.
- Older pages open with a Latin title preamble (date and ang) ahead of the Gurmukhi. Its date and ang are checked against the page and then skipped.
- Older titles cite an ang range, such as `ANG 947-948`. A range agrees when it contains the single cited ang.
- A Devanagari anusvara is sometimes typed in place of the Gurmukhi bindi. It stays with its Gurmukhi word.
- Some pages leave out the danda between the heading and the first line. The parser splits the heading back off when the corpus shows its leading words are a heading and the rest is a bani line (2 of 160 validation days). The run log reports this as `heading_split`.

SGPC (the validation reference):

- The archive endpoint is named `hssearchhukmanamaTestCalender.php` (POST `selected_date=YYYY-MM-DD`). The "Test" is part of the contract.
- The English ang label is either `(Page: N)` or `(Ang: N)`.
- The index page puts a double space before the time: `DD-MM-YYYY  HH:MM AM`.
- That timestamp is the reading time (about 05:15 IST), not the posting time.
- No cookie is set or needed, unlike Hazur Sahib's site, which requires a CodeIgniter session cookie.
- A day with nothing published returns HTTP 200 with `supported: false`.

## Running it

```bash
npm ci
npm install --no-save @shabados/database@4.8.7
SHABADOS_DB=node_modules/@shabados/database/build/database.sqlite npm test
```

`test/bench.js` draws a **seeded** sample, so a green run means the same thing on every machine and every CI run. Sweep wider with `BENCH_SEED` and `BENCH_N`:

```bash
for seed in 1 2 3 4 5; do BENCH_SEED=$seed node test/bench.js; done
```

The corpus is 152 MB unpacked and is **never committed**. CI installs it fresh each run, pinned.

The daily job (`bin/fetch-today.js`) writes nothing on failure and exits non-zero, so the workflow goes red rather than publishing something wrong. A missing file is a clean 404; a wrong file is wrong Gurbani in front of someone. It runs five times a day (08:07 to 16:37 IST). A run that finds no morning page for today yet is a no-op, and only the last scheduled run (`FINAL_RUN=1`) goes red if the day never appeared. On the validation days the source's pages were last modified at a median of 05:09 IST on their own date.

Every run prints one JSON line to stdout and to the GitHub step summary:

```json
{"run_utc":"2026-10-14T02:07:00.000Z","page_date":"2026-10-14","page_time":null,"page_created_utc":null,"page_modified_utc":"2026-10-13T23:53:49.000Z","heading_split":false,"outcome":"written","shabad_ids":["DWV"],"confidence":"high"}
```

- `page_date`: the date the page says it is for. `page_time` is always `null` (the source gives no reading time).
- `page_created_utc`, `page_modified_utc`: the post's own timestamps from the page data, `null` when absent.
- `heading_split`: `true` when the parser split a heading off the first line because the source left out the danda between them, `false` otherwise, `null` when no page was read.
- `outcome`: `written`, `unchanged` (a re-run reproduced the same bytes), `replaced` (the day changed after it was first written; adds `previous_ids`), `not_yet` (no morning page for today yet) or `refused` (adds `reason`).

The line is never written to a file, so `archive/` stays byte-identical across re-runs. None of these fields appear in the archive files.

Politeness: requests are spaced at least 3 seconds apart, at most five a day, and carry an identifying User-Agent.

### Scripts

| Script | Purpose |
|---|---|
| `bin/fetch-today.js` | Daily job. Writes nothing on failure and exits non-zero. |
| `bin/poll-latest.js` | Polls the index page every 30 minutes to measure when SGPC posts. Writes `poll-log.txt` only. |
| `bin/harvest-validation.js` | Cache-first fetch of archive days for validation. Resumable. |
| `bin/validate.js` | Resolves the cached days and compares them with gurbaninow. |
| `bin/analyse.js` | Produces `validation/report.md`. Instant, reads from disk. |
| `bin/harvest-hns.js` | Cache-first fetch of hukamnamasahib.com morning pages for the validation days. |
| `bin/crosscheck-hns.js` | Compares the cached hukamnamasahib.com pages with the cached SGPC days. Produces `validation/hns-crosscheck.md`. No network. |
| `bin/trim-hns-fixture.js` | Cuts a saved hukamnamasahib.com page down to a gate-clean test fixture. |
| `bin/gate.js` | Pre-push checks (`npm run gate`). |

### Before the first push

`npm run gate` prints PASS or FAIL for each check and exits 1 on any FAIL. The archive check expects `archive/` to hold no dated files and no `latest.json`. That is expected before first push only; once the daily job has published, this check fails by design.

## Corpus version

IDs are resolved against `@shabados/database@4.8.7` and every file records the version used. Shabad OS has signalled a v5 rewrite with a new schema and possible identifier changes. Clients should read `corpus.version` rather than assuming.

## Licensing

Three separate layers, worth keeping distinct:

**Code**: MIT, see [LICENSE](LICENSE).

**The published IDs**: these are derived output, short identifiers pointing into [`@shabados/database`](https://github.com/shabados/database) (MIT code, CC0 corpus). No Gurbani text is published in `archive/`, and no translation or transliteration is reproduced anywhere in this repository. The test fixtures under `test/` hold the Gurmukhi of a few days so the parser and resolver can be tested offline. Use the IDs freely.

**The Hukamnama selection**: the choice of shabad on any given day belongs to Sachkhand Sri Harimandar Sahib. This project records that choice; it does not produce it.

Scraping is limited to at most five requests a day, at least 3 seconds apart, with an identifying User-Agent.

## Acknowledgments

- **SGPC**, for publishing the daily Hukamnama from Sri Harimandar Sahib openly.
- **[HukamnamaSahib.com](https://hukamnamasahib.com)**, whose morning page mirrors SGPC's daily hukamnama and is the daily source.
- **[Shabad OS](https://github.com/shabados)**, for the corpus and for `gurmukhi-utils`, without which none of the encoding work would be tractable.
- **[gurbaninow/hukamnama-archive](https://github.com/gurbaninow/hukamnama-archive)** (MIT), the validation reference and the ID-pointer format this follows. Its recent days appear to come from its SikhNet fallback, so it is a reference, not an authority.

## Contact

harkiratsingh135790@gmail.com: for corrections, for breakage, and in particular for any concern from SGPC or the sangat.
