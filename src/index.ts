interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * vc-finder — VC / angel investor graph (Bruce ask 2026-09-29; built
 * private-first, PUBLIC since fleet #2663). Plan: docs/vc-graph-plan.md. Architecture, DDL, extraction and
 * entity-resolution design: docs/vc-graph-architecture.md,
 * sql/vc-finder-schema.sql, sql/vc-finder-queries.sql.
 *
 * PUBLIC PACK (fleet #2663, Bruce 2026-10-01 "just make it live; it will be
 * easier to test"). It was private-first through fleet #2579 — the first
 * customer was Mojibake's own raise, not external demand (plan §1) — and the
 * gate that made it answer outsiders as though it did not exist is now REMOVED:
 * no assertAllowed in this file, no NOT_FOUND_PRIVATE_SLUGS entry in
 * workers/gateway/src/index.ts, no PRIVATE_PACKS entry, listed in MCP_PACKS and
 * in the website catalog. Any caller can call every tool here.
 *
 * PEOPLE DATA, and the one rule that governs it (Bruce case ruling 2026-09-30,
 * fleet #2561; CLAUDE.md "Personal data"): vc_search_people, vc_get_person,
 * vc_get_investor's partners list and vc_find_investors_for_company's
 * relevant_partner serve investing people with the contact routes THOSE PEOPLE
 * PUBLISHED — on a firm's own site or their own page — each carrying the page it
 * came from, the quoted text showing it, and a personal/role label. Phone
 * numbers and home addresses are never collected. Anyone can ask to be removed
 * at support@pipeworx.io; removal is enforced at READ time, not only at load
 * time (removal_entry + exposure_hold in workers/vc-index/src/queries.ts,
 * tests in queries.people.test.mts). Now that the pack is public, that removal
 * path has to be visible to the people in it — which is why it is stated in
 * the two people tools' own descriptions and in the README, not just here.
 *
 * Every tool answer is STATED-FIT v0 (plan §6 phase 2): coverage is
 * `"partial"` on every response — public sources will never match a paid
 * vendor's investor→round coverage (docs/vc-graph-plan.md §3) — and every
 * fact carries its own claim-level source (`sources`) plus the freshest
 * `data_as_of` across those claims. `vc_find_investors_for_company` is an
 * EXPLAINABLE CHECKLIST, never an opaque score: each criterion is a named
 * boolean or count a caller can read and disagree with individually.
 *
 * Read path: the pipeworx-vc-index worker, reached by service binding
 * (_vcIndex). Store and loading: docs/vc-graph-architecture.md §0. Keep
 * tool descriptions about WHAT is returned, never where it is served from
 * (feedback_never_disclose_hosting; pnpm check:hosting-claims).
 */


// ── The RPC surface a service-binding-shaped `_vcIndex` must expose. In
// production this is the Cloudflare service binding to pipeworx-vc-index
// (workers/vc-index) — Cloudflare RPC, so these are plain async method calls,
// never HTTP requests. Typed narrowly here (not `Fetcher`) because this pack calls
// named RPC methods, not HTTP verbs, on the bound object — see
// docs/vc-graph-architecture.md §6 and the POD_INDEX precedent
// (tests/injected-secrets-classified.test.ts: "a service binding object …,
// not a string").
export interface VcIndexBinding {
  searchInvestors(args: Record<string, unknown>): Promise<unknown>;
  getInvestor(id: string): Promise<unknown>;
  getFund(id: string): Promise<unknown>;
  getCompany(id: string): Promise<unknown>;
  searchRounds(args: Record<string, unknown>): Promise<unknown>;
  whoInvestedIn(companyId: string): Promise<unknown>;
  getEvidence(claimId: string): Promise<unknown>;
  findInvestorsForCompany(args: Record<string, unknown>): Promise<unknown>;
  searchPeople(args: Record<string, unknown>): Promise<unknown>;
  getPerson(id: string): Promise<unknown>;
}

const COVERAGE = 'partial' as const;
const COVERAGE_NOTE =
  'Public-source coverage (SEC ADV/Form D, firm websites, newswire) — well below a paid vendor\'s investor→round coverage. Absence of a match here is not evidence an investor is inactive.';

function extractDataAsOf(payload: unknown): string | null {
  if (Array.isArray(payload)) {
    const dates = payload
      .map((row) => (row && typeof row === 'object' ? (row as Record<string, unknown>).data_as_of : null))
      .filter((d): d is string => typeof d === 'string');
    return dates.length ? dates.sort().at(-1)! : null;
  }
  if (payload && typeof payload === 'object') {
    const d = (payload as Record<string, unknown>).data_as_of;
    return typeof d === 'string' ? d : null;
  }
  return null;
}

function envelope(payload: unknown, extra?: Record<string, unknown>) {
  return {
    coverage: COVERAGE,
    coverage_note: COVERAGE_NOTE,
    data_as_of: extractDataAsOf(payload),
    ...extra,
    result: payload,
  };
}

function vcIndex(args: Record<string, unknown>): VcIndexBinding {
  const idx = args._vcIndex as VcIndexBinding | undefined;
  if (!idx) {
    throw new Error('vc-finder is not configured on this deployment — an operator must enable its VC_INDEX service binding.');
  }
  return idx;
}

const tools: McpToolExport['tools'] = [
  {
    name: 'vc_search_investors',
    description:
      'Search VC firms, CVCs, solo GPs, accelerators and angel groups by stated investment strategy — sector, stage, check size, geography. Stated-only (Phase 2); coverage is partial and every result carries its own per-fact sources.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        investor_type: { type: 'string', description: 'org_type filter: vc_firm, cvc, family_office, accelerator, angel_group, syndicate, solo_gp, pe_growth, studio' },
        sector: { type: 'string', description: 'Stated sector/focus area, e.g. "devtools", "fintech"' },
        stage: { type: 'string', description: 'Stated financing-round stage, e.g. "seed", "series_a"' },
        check_usd: { type: 'number', description: 'A check size in USD that must fall inside the investor\'s stated [check_min_usd, check_max_usd] range' },
        geo: { type: 'string', description: 'HQ country, e.g. "US"' },
        name: { type: 'string', description: 'Substring/partial name search over canonical names and aliases (FTS5 trigram) — tolerant of truncation and minor character-level variation, not a full edit-distance fuzzy match' },
        limit: { type: 'number', description: 'Max results (default 20)' },
      },
    },
    outputSchema: {
      type: 'object' as const,
      properties: {
        coverage: { type: 'string' },
        coverage_note: { type: 'string' },
        data_as_of: { type: ['string', 'null'] },
        result: { type: 'array', items: { type: 'object' } },
      },
    },
  },
  {
    name: 'vc_get_investor',
    description: 'Get one investor organization by id: identity, aliases, external ids (CRD/SEC#), funds, its investing people (partners, each with the contact routes they published, their source page and a personal/role label), the firm\'s own published contact routes, stated strategy, and per-fact sources.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        investor_id: { type: 'string', description: 'Organization id, from vc_search_investors' },
      },
      required: ['investor_id'],
    },
    outputSchema: {
      type: 'object' as const,
      properties: {
        coverage: { type: 'string' },
        coverage_note: { type: 'string' },
        data_as_of: { type: ['string', 'null'] },
        result: { type: ['object', 'null'] },
      },
    },
  },
  {
    name: 'vc_get_fund',
    description: 'Get one private fund by id: name, vintage, VC-fund flag (ADV Schedule D 7.B), gross asset value, managing organization, and per-fact sources.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        fund_id: { type: 'string', description: 'Fund id, from vc_get_investor\'s funds list' },
      },
      required: ['fund_id'],
    },
    outputSchema: {
      type: 'object' as const,
      properties: {
        coverage: { type: 'string' },
        coverage_note: { type: 'string' },
        data_as_of: { type: ['string', 'null'] },
        result: { type: ['object', 'null'] },
      },
    },
  },
  {
    name: 'vc_get_company',
    description: 'Get one company by id: identity, sector, maturity stage, and its financing rounds.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        company_id: { type: 'string', description: 'Company id, from vc_search_rounds' },
      },
      required: ['company_id'],
    },
    outputSchema: {
      type: 'object' as const,
      properties: {
        coverage: { type: 'string' },
        coverage_note: { type: 'string' },
        data_as_of: { type: ['string', 'null'] },
        result: { type: ['object', 'null'] },
      },
    },
  },
  {
    name: 'vc_search_rounds',
    description: 'Search financing rounds by sector, stage and date window — answers "funding rounds this week/quarter". Sourced from SEC Form D and newswire funding announcements; coverage is partial.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        sector: { type: 'string', description: 'Company sector' },
        stage: { type: 'string', description: 'financing_round_stage: pre_seed, seed, series_a, series_b, series_c_plus, growth, pe, ipo, other' },
        date_from: { type: 'string', description: 'ISO date, inclusive lower bound on announced_date' },
        date_to: { type: 'string', description: 'ISO date, inclusive upper bound on announced_date' },
        limit: { type: 'number', description: 'Max results (default 20)' },
      },
    },
    outputSchema: {
      type: 'object' as const,
      properties: {
        coverage: { type: 'string' },
        coverage_note: { type: 'string' },
        data_as_of: { type: ['string', 'null'] },
        result: { type: 'array', items: { type: 'object' } },
      },
    },
  },
  {
    name: 'vc_who_invested_in',
    description: 'List the investors named in a company\'s financing rounds — role (lead/participant), amount where disclosed, and the evidence (source URL + quoted snippet) behind each edge.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        company_id: { type: 'string', description: 'Company id, from vc_search_rounds' },
      },
      required: ['company_id'],
    },
    outputSchema: {
      type: 'object' as const,
      properties: {
        coverage: { type: 'string' },
        coverage_note: { type: 'string' },
        data_as_of: { type: ['string', 'null'] },
        result: { type: 'array', items: { type: 'object' } },
      },
    },
  },
  {
    name: 'vc_get_evidence',
    description: 'Get the full provenance of one claim by id: source URL, source type, retrieval date, the extractor version, confidence, and the verbatim evidence text. Every other tool\'s "sources" field is a list of these ids.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        claim_id: { type: 'string', description: 'Claim id, from any other tool\'s sources array' },
      },
      required: ['claim_id'],
    },
    outputSchema: {
      type: 'object' as const,
      properties: {
        result: { type: ['object', 'null'] },
      },
    },
  },
  {
    name: 'vc_find_investors_for_company',
    description:
      'Explainable stated-fit matcher (v0): for a company\'s sector, stage, check size and geography, rank candidate investors by an EXPLAINABLE CHECKLIST of five criteria (sector_match, stage_match, check_size_match, geo_match, active) plus relevant_portfolio_count — never a single opaque score. sector_match is true when the firm states the sector OR has observed portfolio companies in it; stage_match when it states the stage OR is on an observed round at that stage; check_size_match when its stated check range OR the range of disclosed round sizes it has been on contains check_usd (round sizes, not its own check). sector_basis / stage_basis / check_basis say which evidence decided (stated, observed, both). Accelerators (Y Combinator, Techstars, Antler, ...) are excluded unless include_accelerators is true. Each firm carries relevant_partner — the most senior investing person known there, with their published contact routes — or null when none is known. geo accepts any country spelling or ISO code (US, USA, United States) or a region (north_america, europe, asia_pacific, global); geo_match uses the firm\'s stated investment geography when it has one, else its HQ, and is null when there is no evidence either way. Sorted by criteria_met, then relevant_portfolio_count, then deals in the last 24 months, then sector focus (fewer declared sectors first), then name.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        sector: { type: 'string', description: 'Company sector, e.g. "devtools"' },
        stage: { type: 'string', description: 'Round stage being raised, e.g. "seed"' },
        check_usd: { type: 'number', description: 'Target check size in USD' },
        geo: { type: 'string', description: 'Company country or region, e.g. "US", "United States", "north_america"' },
        limit: { type: 'number', description: 'Max candidates (default 10)' },
        include_accelerators: { type: 'boolean', description: 'Also rank accelerators (Y Combinator, Techstars, Antler, ...). Default false.' },
      },
      required: ['sector', 'stage'],
    },
    outputSchema: {
      type: 'object' as const,
      properties: {
        coverage: { type: 'string' },
        coverage_note: { type: 'string' },
        data_as_of: { type: ['string', 'null'] },
        result: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              canonical_name: { type: 'string' },
              sector_match: { type: 'boolean' },
              sector_basis: { type: ['string', 'null'], enum: ['stated', 'observed', 'both', null] },
              stage_basis: { type: ['string', 'null'], enum: ['stated', 'observed', 'both', null] },
              observed_stage_rounds: { type: 'number' },
              check_basis: { type: ['string', 'null'], enum: ['stated', 'observed', 'both', null] },
              observed_round_range_usd: { type: ['array', 'null'], items: { type: 'number' } },
              org_type: { type: 'string' },
              stage_match: { type: 'boolean' },
              check_size_match: { type: 'boolean' },
              geo_match: { type: ['boolean', 'null'] },
              geo_basis: { type: ['string', 'null'], enum: ['stated', 'hq', null] },
              hq_country_iso: { type: ['string', 'null'] },
              stated_geography: { type: 'array', items: { type: 'string' } },
              relevant_portfolio_count: { type: 'number' },
              investments_24m: { type: ['number', 'null'] },
              stated_sector_count: { type: 'number' },
              active: { type: 'boolean' },
              criteria_met: { type: 'number' },
              criteria_total: { type: 'number' },
              relevant_partner: { type: ['object', 'null'] },
              sources: { type: 'array', items: { type: 'object' } },
            },
          },
        },
      },
    },
  },
  {
    name: 'vc_search_people',
    description:
      'Search investing people — partners, principals, associates, scouts, venture partners, fund GPs, angels, syndicate leads — by role, firm, the firm\'s sector, the firm\'s HQ geography, or name. Returns each person\'s current firms and which kinds of contact route they published (email, LinkedIn, X, personal site). Only people in an investing role are included. People and their contact routes come from public sources — the firm\'s own site or the person\'s own published page — and every route carries the page it was published on and the quoted text showing it. Phone numbers and home addresses are never collected. Anyone can request removal at support@pipeworx.io.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Part of the person\'s name' },
        role: { type: 'string', description: 'Investing role: partner, principal, associate, scout, venture_partner, operating_partner, angel, syndicate_lead, solo_gp, fund_gp, other_investor (or an org role such as gp, managing_director)' },
        firm_id: { type: 'string', description: 'Organization id, from vc_search_investors' },
        firm: { type: 'string', description: 'Firm name, partial match over names and aliases' },
        sector: { type: 'string', description: 'The firm\'s sector: a normalized leaf (e.g. "ai_infrastructure") or the firm\'s own stated tag' },
        geo: { type: 'string', description: 'The firm\'s HQ country or region, e.g. "US", "United States", "europe"' },
        with_contact: { type: 'boolean', description: 'Only people who published at least one contact route' },
        limit: { type: 'number', description: 'Max results (default 20)' },
      },
    },
    outputSchema: {
      type: 'object' as const,
      properties: {
        coverage: { type: 'string' },
        coverage_note: { type: 'string' },
        data_as_of: { type: ['string', 'null'] },
        result: { type: 'array', items: { type: 'object' } },
      },
    },
  },
  {
    name: 'vc_get_person',
    description:
      'Get one investing person by id: investing role, roles and firm history, companies, their own investments, and every contact route they published (email, LinkedIn, X, personal site), each with the page it was published on, the quoted text showing it, and whether it is a personal or a role address. Phone numbers and home addresses are never collected. People and their contact routes come from public sources — the firm\'s own site or the person\'s own published page. Anyone can request removal at support@pipeworx.io.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        person_id: { type: 'string', description: 'Person id, from vc_search_people, vc_get_investor partners, or relevant_partner' },
      },
      required: ['person_id'],
    },
    outputSchema: {
      type: 'object' as const,
      properties: {
        coverage: { type: 'string' },
        coverage_note: { type: 'string' },
        data_as_of: { type: ['string', 'null'] },
        result: { type: ['object', 'null'] },
      },
    },
  },
];

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  const idx = vcIndex(args);

  switch (name) {
    case 'vc_search_investors': {
      const r = await idx.searchInvestors({
        investor_type: args.investor_type ?? null,
        sector: args.sector ?? null,
        stage: args.stage ?? null,
        check_usd: args.check_usd ?? null,
        geo: args.geo ?? null,
        name: args.name ?? null,
        limit: args.limit ?? 20,
      });
      return envelope(r);
    }
    case 'vc_get_investor': {
      if (!args.investor_id) throw new Error('investor_id is required');
      const r = await idx.getInvestor(String(args.investor_id));
      return envelope(r);
    }
    case 'vc_get_fund': {
      if (!args.fund_id) throw new Error('fund_id is required');
      const r = await idx.getFund(String(args.fund_id));
      return envelope(r);
    }
    case 'vc_get_company': {
      if (!args.company_id) throw new Error('company_id is required');
      const r = await idx.getCompany(String(args.company_id));
      return envelope(r);
    }
    case 'vc_search_rounds': {
      const r = await idx.searchRounds({
        sector: args.sector ?? null,
        stage: args.stage ?? null,
        date_from: args.date_from ?? null,
        date_to: args.date_to ?? null,
        limit: args.limit ?? 20,
      });
      return envelope(r);
    }
    case 'vc_who_invested_in': {
      if (!args.company_id) throw new Error('company_id is required');
      const r = await idx.whoInvestedIn(String(args.company_id));
      return envelope(r);
    }
    case 'vc_get_evidence': {
      if (!args.claim_id) throw new Error('claim_id is required');
      const r = await idx.getEvidence(String(args.claim_id));
      // Evidence is the provenance record itself — no coverage/data_as_of
      // wrapper (there is nothing "partial" about a single claim's own facts).
      return { result: r };
    }
    case 'vc_find_investors_for_company': {
      if (!args.sector || !args.stage) throw new Error('sector and stage are required');
      const r = await idx.findInvestorsForCompany({
        sector: args.sector,
        stage: args.stage,
        check_usd: args.check_usd ?? null,
        geo: args.geo ?? null,
        limit: args.limit ?? 10,
        include_accelerators: args.include_accelerators === true,
      });
      return envelope(r, {
        matcher_note: 'Stated + observed fit — criteria_met is a count of independently-readable checks, not a weighted score. Each *_basis field says whether a check was met on the firm\'s stated strategy, on observed deals, or both. Observed evidence is sparse (most rounds have no disclosed stage or amount), so a false check often means "no evidence", not "no".',
      });
    }
    case 'vc_search_people': {
      const r = await idx.searchPeople({
        name: args.name ?? null,
        role: args.role ?? null,
        firm_id: args.firm_id ?? null,
        firm: args.firm ?? null,
        sector: args.sector ?? null,
        geo: args.geo ?? null,
        with_contact: args.with_contact ?? null,
        limit: args.limit ?? 20,
      });
      return envelope(r);
    }
    case 'vc_get_person': {
      if (!args.person_id) throw new Error('person_id is required');
      const r = await idx.getPerson(String(args.person_id));
      return envelope(r);
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export default { tools, callTool, meter: { credits: 2 } } satisfies McpToolExport;
