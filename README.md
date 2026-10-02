# vc-finder

VC / angel investor graph: which investors fit a raise, who is on which
round, and which investing person at a firm to approach — every fact carrying
the page it came from. Built for Mojibake's own raise first (Bruce ask
2026-09-29) and **public since fleet #2663** (Bruce 2026-10-01: *"just make it
live; it will be easier to test"*). Not npm-published — that is a separate
Bruce-gated path. See `docs/vc-graph-plan.md`, `docs/vc-graph-architecture.md`,
`docs/vc-finder-staging-contract.md`.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1688+ live data sources. This is an independent, unofficial integration — not affiliated with, endorsed by, or published by the upstream provider.

## Store: D1, not Postgres (fleet #2526 store-change)

The architecture doc (§1) originally called for a dedicated Supabase Postgres
project. **Superseded 2026-09-30 by the PM (Bruce ruled out new Supabase
spend): the store is ONE Cloudflare D1 database.** Schema:
`sql/vc-finder-schema.sqlite.sql` — a narrow port (only the tables this pack's
8 tools need) written because Liesel's full port was not yet on `origin/main`
when this was built in parallel. **Reconcile the two when hers lands; delete
this one rather than let two schema files drift.**

## Shape

- `mcps/vc-finder/` — this pack. 10 tools, `vc_` prefixed. Calls a
  `_vcIndex` service-binding-shaped object (RPC methods, not fetch — see
  `VcIndexBinding` in `src/index.ts`), the same shape as the POD_INDEX
  precedent (`workers/pod-index`, `docs/pod-researcher-design.md`).
- `workers/vc-index/` — the `pipeworx-vc-index` worker skeleton. A
  `WorkerEntrypoint` exposing one RPC method per tool, backed by
  `src/queries.ts` (parameterized SQL against the D1 binding — no stored
  procedures; D1 has none). **Deployed (fleet #2579)** against the
  `pipeworx-vc-finder` D1 database; CI redeploys the code on push
  (`.github/workflows/deploy-vc-index.yml`) and never touches the data.
- `scripts/vc-finder/fixtures/seed.sqlite.sql` — fixed-id fixtures (a16z,
  Sequoia, SignalFire, two companies, two rounds, claims with provenance,
  precomputed `investor_sector_portfolio_counts` /
  `investor_observed_stats` rows) for local testing only.

## Local test (never a remote D1 database)

```bash
wrangler d1 execute VC_INDEX_DB --local --cwd workers/vc-index \
  --file sql/vc-finder-schema.sqlite.sql -y
wrangler d1 execute VC_INDEX_DB --local --cwd workers/vc-index \
  --file scripts/vc-finder/fixtures/seed.sqlite.sql -y
```

Then either query directly (`wrangler d1 execute VC_INDEX_DB --local --cwd
workers/vc-index --command "..."`) or run the pack's `callTool()` against the
resulting local D1 sqlite file (`workers/vc-index/.wrangler/state/v3/d1/...`)
via a harness that mocks `_vcIndex` with `src/queries.ts`'s functions — see
fleet #2526's task record for the exact harness used to produce the
acceptance evidence (compiled with `tsc`, run with Node's `node:sqlite`).

## People and contact routes (fleet #2561)

Bruce's 2026-09-30 case ruling: investing people are served with the contact
routes they published. `vc_search_people` and `vc_get_person` are the two
people tools; `vc_get_investor` lists a firm's partners with their routes, and
`vc_find_investors_for_company` names a `relevant_partner` per firm when one is
known (most senior investing role, then one with a published route). Every
path serves only `exposure_hold = 0` people and checks the removal list
(`removal_entry`, mirrored from `scripts/vc-finder/removal-list.json`) at read
time. Tests: `workers/vc-index/src/queries.people.test.mts`. Load/ER details:
`docs/vc-finder-staging-contract.md` "How the store loads and serves them".

**Source and removal, stated where a caller can see it (required now that the
pack is public — CLAUDE.md "Personal data", Bruce's case ruling).** People and
their contact routes come from **public sources only**: the firm's own site or
the person's own published page. Every route carries the page it was published
on, the quoted text showing it, and a personal-or-role label. **Phone numbers
and home addresses are never collected.** Anyone can request removal at
**support@pipeworx.io** — add them to `scripts/vc-finder/removal-list.json` and
the read path drops them immediately; it does not wait for the next load. The
`vc_search_people` and `vc_get_person` descriptions carry this same statement,
so it reaches a caller who never reads this file, and
`tests/scope-is-not-a-gate.test.ts` fails if either description loses it.

## Public since fleet #2663 — what the private gate was, and what replaced it

Through fleet #2579 this pack was `unlisted` in the manifest, listed in
`PRIVATE_PACKS`, hidden as **not found** from everyone outside
`BOARD_OWNER_CALLERS` + internal traffic (`NOT_FOUND_PRIVATE_SLUGS` in
`workers/gateway/src/index.ts`), and re-checked the same rule inside the pack
via `assertAllowed()`. **All four are gone.** Any caller can call every tool.

`NOT_FOUND_PRIVATE_SLUGS` is now an EMPTY set rather than deleted — it is the
next private pack's gate, and with no members `privatePackVisible()` answers
true for every slug, so a green test over it proves nothing about the not-found
path. That is said out loud at the set's definition.

What protects the people in the graph is therefore no longer the gate; it is the
read-time removal check below, which was always the real control.

## Refreshing the deployed data

The D1 database holds a SERVING copy, never the full local build:

```bash
node scripts/vc-finder/build-deploy-copy.mjs "$VC_DATA/<build>.sqlite" "$VC_DATA/vc_finder_deploy.sqlite"
node scripts/vc-finder/d1-export-chunks.mjs "$VC_DATA/vc_finder_deploy.sqlite" "$VC_DATA/d1-import"
node scripts/vc-finder/d1-import.mjs "$VC_DATA/d1-import"      # resumable; verifies row counts
```

`build-deploy-copy.mjs` drops every held person (`exposure_hold = 1`) and
every row that exists only because of one, person-flagged companies, and
merged-away companies nothing references, and refuses to finish if any held
person or orphan survives. The import targets a fresh database (the schema
file is plain `CREATE`s); to refresh, create a new database, import, then
point `database_id` at it.

## Known gaps (v0 skeleton, not fixed by this task)

- `vc_find_investors_for_company` still scores every VC-shaped organization
  per call, but in a fixed number of set queries (fleet #2579 — it used to be
  three D1 queries per candidate, which on the real store is past D1's
  1,000-queries-per-invocation limit). A materialized stated-fit candidate
  table would cut the rows read.
- Money fields are `REAL` — fine for whole-dollar amounts in these fixtures,
  worth revisiting (integer cents) once real amounts include cents.
- No loader/insert path here — this is the READ side only, per the task.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "vc-finder": {
      "url": "https://gateway.pipeworx.io/vc-finder/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/vc-finder/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1688+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/vc_search_investors \
  -H 'Content-Type: application/json' \
  -d '{"stage":"seed","geo":"US","limit":5}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/vc_search_investors`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Standalone (no gateway account)

This package also runs as a local stdio MCP server — no Pipeworx account, no
gateway round-trip:

```json
{
  "mcpServers": {
    "vc-finder": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-vc-finder"]
    }
  }
}
```

Or run it directly to confirm it starts:

```bash
npx -y @pipeworx/mcp-vc-finder
```

It speaks MCP over stdin/stdout and answers `initialize`/`tools/list`/`tools/call`
for **only** this pack's tools — none of the shared meta-tools the gateway
connection above adds. Same source, same tools, no ask_pipeworx routing.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Vc Finder data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
