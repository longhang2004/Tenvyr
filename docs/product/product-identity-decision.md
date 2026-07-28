# Product Identity Decision

**Decision status: Owner-approved for repository implementation.**

The owner has approved the local, private repository implementation of the
Tenvyr identity. Branding, private npm package identities, TypeScript Worker
API symbols, documented/example configuration, runtime User-Agent values, and
schema identities have been renamed in this repository.

This approval does not establish ownership or availability of an npm scope,
domain, GitHub identity, PyPI distribution, or container namespace. External
reservation, the public license, counsel-led trademark review, repository
rename, publication, and public release remain unfinished owner actions. The
owner has separately authorized the private local Python Worker implementation;
that authorization does not include PyPI reservation or publication.

## Decision summary

| Role           | Name    | Reason                                                                 |
| -------------- | ------- | ---------------------------------------------------------------------- |
| Recommendation | Tenvyr  | Best overall positioning, developer ergonomics, and registry evidence. |
| Fallback       | Exaryn  | Strong execution narrative and the cleanest domain evidence.           |
| Reserve        | Sutryva | Strong supervision narrative, with weaker spelling ergonomics.         |

All availability evidence in this document was checked on **2026-07-27**.
Registry absence is not availability, reservability, ownership, or legal
clearance. Trademark results are **unverified**, not “clear.”

## Context and positioning

AgentWeave collides with existing uses of the same or a closely related name.
That collision makes public package, repository, domain, and search identity
ambiguous before a first public release.

The product is a **framework-neutral execution control plane outside the agent
process**. It owns contracts, dispatch, supervision, security and policy, and
durable orchestration. Agent frameworks continue to own agent internals.
Observability is a projection of execution truth, not the product's defining
category or transactional state.

The primary audience is platform engineers, AI infrastructure engineers, and
teams operating production agent workloads across frameworks and model
providers. The identity must remain broad enough for:

```text
Run · Control · Secure · Observe · Explain · Replay · Evaluate
```

The name must not imply another agent framework, a model provider, an
observability-only tool, a queue, or a coding agent.

## Naming criteria

Each finalist is rated from 1 to 5. The normalized score is:

```text
round(sum(rating × weight) / 5, 1)
```

| Criterion                    | Weight |
| ---------------------------- | -----: |
| Product-positioning fit      |     20 |
| Distinctiveness              |     15 |
| Memorability                 |     10 |
| Pronounceability             |     10 |
| GitHub availability evidence |     10 |
| npm/package-scope evidence   |     10 |
| PyPI evidence                |      5 |
| Domain options               |     10 |
| Search/SEO uniqueness        |      5 |
| International usability      |      5 |

Hard filters reject an exact active AI/software product name, a serious package
ecosystem collision, difficult spelling or pronunciation, provider dependence,
a narrow feature label, or a name that implies a fork of another product.

## Initial pool

The pool contains exactly 15 candidates. Hard filters were applied before
finalist scoring.

| #   | Candidate | Result   | Narrative or hard-filter finding                                          |
| --- | --------- | -------- | ------------------------------------------------------------------------- |
| 1   | Tenvyr    | Finalist | “Tenet + environment”: execution remains inside declared intent.          |
| 2   | Exaryn    | Finalist | “Execution + array/arena”: a neutral field where runtimes are controlled. |
| 3   | Sutryva   | Finalist | “Supervision + runtime + via”: a governed execution path.                 |
| 4   | Serevon   | Finalist | “Service + governance”: a supervisory envelope around execution.          |
| 5   | Merynt    | Finalist | “Mesh + intent”: a runtime fabric binding runs to policy intent.          |
| 6   | Talvryn   | Finalist | “Support layer + invariant”: a durable control layer below runtimes.      |
| 7   | Orvexa    | Rejected | Exact active AI automation, financial extraction, and trading brands.     |
| 8   | Korvane   | Rejected | Exact active software/AI systems company and digital-capital platform.    |
| 9   | Qorvia    | Rejected | Exact active AI, software, and automation brands.                         |
| 10  | Velynt    | Rejected | Exact active AI-workflow consultancy.                                     |
| 11  | Covaryn   | Rejected | Exact active workflow-automation company in a directly adjacent space.    |
| 12  | Telyra    | Rejected | Exact active UCaaS/VoIP product and other software platforms.             |
| 13  | Averiq    | Rejected | Multiple exact active data/AI and software companies.                     |
| 14  | Vorynt    | Rejected | Exact active software-engineering company and application.                |
| 15  | Kadrivo   | Rejected | Exact active HR and team-management software.                             |

The rejected-name evidence includes
[Orvexa](https://orvexa.ai/),
[Korvane Systems](https://korvane.tech/),
[Qorvia Technologies](https://qorviatechnologies.com/services/ai-and-chatbots/),
[Velynt](https://www.velynt.ai/), [Covaryn](https://www.covaryn.com/),
[Telyra](https://telyra.io/), [AverIQ](https://averiq.ai/about.html?v=2),
[Vorynt Systems](https://www.vorynt.dev/), and
[Kadrivo](https://kadrivo.pl/).

## Finalist scorecard

The ten rating columns follow the criterion order above.

| Finalist | Positioning | Distinctive | Memorable | Pronounceable | GitHub | npm | PyPI | Domains | Search | International | Weighted score |
| -------- | ----------: | ----------: | --------: | ------------: | -----: | --: | ---: | ------: | -----: | ------------: | -------------: |
| Tenvyr   |           5 |           5 |         4 |             5 |      5 |   5 |    5 |       4 |      4 |             5 |           95.0 |
| Exaryn   |           4 |           5 |         4 |             4 |      5 |   5 |    5 |       5 |      5 |             4 |           91.0 |
| Sutryva  |           5 |           5 |         3 |             3 |      5 |   5 |    5 |       4 |      5 |             3 |           88.0 |
| Serevon  |           4 |           3 |         4 |             5 |      5 |   5 |    5 |       3 |      3 |             5 |           82.0 |
| Merynt   |           4 |           4 |         4 |             4 |      2 |   5 |    5 |       4 |      2 |             4 |           77.0 |
| Talvryn  |           4 |           4 |         4 |             3 |      2 |   5 |    5 |       4 |      2 |             3 |           74.0 |

The scores were recomputed from the integer ratings. No tie-break was needed.
If a future rescore ties, compare positioning fit, distinctiveness, package
viability, then memorability in that order.

## Finalist details

### Tenvyr — `TEN-veer`

- **Meaning and fit:** “tenet + environment”; the control plane that keeps
  agent execution within declared intent. It covers the full product roadmap
  without depending on a framework or model provider.
- **Strengths:** compact, pronounceable, policy-forward, and clean in public
  developer-registry checks. It produces readable symbols such as
  `TenvyrWorker`.
- **Weaknesses:** the invented `y` spelling must be taught once; an exact gamer
  handle appears in search; `tenvyr.com` has an RDAP record.
- **Package proposal:** `@tenvyr/contracts`, `@tenvyr/worker`,
  `tenvyr-worker`, `@tenvyr/cli`, and `@tenvyr/otel`.
- **Domain patterns:** prefer `tenvyr.dev`; `.dev`, `.io`, `.ai`, and
  `tenvyrhq.com` returned no exact RDAP registration record. This is not a
  reservation claim.
- **Collision finding:** no exact software product was found in the performed
  search. The exact [Tenvyr gamer handle](https://u.gg/lol/profile/tr1/s2g%20tenvyr-s2g/overview)
  and close GitHub spelling `tenvyra` reduce perfect search uniqueness.

### Exaryn — `EKS-uh-rin`

- **Meaning and fit:** “execution + array/arena”; a neutral execution field
  where heterogeneous agent runtimes are dispatched and supervised.
- **Strengths:** an immediate execution cue, clean GitHub and package evidence,
  and several useful domain patterns with no exact RDAP record.
- **Weaknesses:** pronunciation can vary, and the name sounds slightly
  clinical or science-fiction. Its narrative is less policy-forward than
  Tenvyr's.
- **Package proposal:** `@exaryn/contracts`, `@exaryn/worker`,
  `exaryn-worker`, `@exaryn/cli`, and `@exaryn/otel`.
- **Domain patterns:** `.io`, `.com`, `useexaryn.com`, and `exarynhq.com`
  returned no exact RDAP record. The preferred `exaryn.dev` remains
  unverified.
- **Collision finding:** no meaningful exact-name software product was found;
  exact-name results were primarily OCR noise.

### Sutryva — `soo-TRY-vuh`

- **Meaning and fit:** “supervision + runtime + via”; the governed route
  through which agent executions run.
- **Strengths:** a direct supervision/runtime story with clean GitHub,
  package, and exact-name search evidence.
- **Weaknesses:** spelling and pronunciation are less obvious, and the coined
  form can resemble a pharmaceutical brand.
- **Package proposal:** `@sutryva/contracts`, `@sutryva/worker`,
  `sutryva-worker`, `@sutryva/cli`, and `@sutryva/otel`.
- **Domain patterns:** `.dev`, `.io`, `.ai`, and `usesutryva.com` returned no
  exact RDAP record.
- **Collision finding:** no meaningful exact-name result was found in the
  performed web and developer-ecosystem searches.

### Serevon — `SEH-reh-von`

- **Meaning and fit:** “service + governance”; a supervisory envelope around
  execution.
- **Strengths:** easy to pronounce, memorable, and usable in public API
  symbols.
- **Weaknesses:** exact commercial and creator uses reduce SEO and legal
  confidence; `serevon.com` is occupied.
- **Package proposal:** `@serevon/contracts`, `@serevon/worker`,
  `serevon-worker`, `@serevon/cli`, and `@serevon/otel`.
- **Domain patterns:** `.dev`, `.io`, `useserevon.com`, and `serevonhq.com`
  returned no exact RDAP record.
- **Collision finding:** exact uses include a
  [Swiss health retreat](https://serevon.info/) and a
  [2026 music release](https://open.spotify.com/album/1ONFuG7aFwnxBsFuSpPVXc).

### Merynt — `MEH-rint`

- **Meaning and fit:** “mesh + intent”; the execution fabric binds runs to
  policy intent.
- **Strengths:** compact, with a strong runtime-fabric narrative and clean
  package evidence.
- **Weaknesses:** the exact GitHub handle is occupied; ancient-name and
  fiction/name associations weaken search uniqueness; spelling can be confused
  with “merit” or “Meryn.”
- **Package proposal:** `@merynt/contracts`, `@merynt/worker`,
  `merynt-worker`, `@merynt/cli`, and `@merynt/otel`.
- **Domain patterns:** `.io`, `.com`, `usemerynt.com`, and `merynthq.com`
  returned no exact RDAP record.
- **Collision finding:** the exact [GitHub user](https://github.com/merynt) is
  occupied, and exact-name search has historical personal-name associations.

### Talvryn — `TAL-vrin`

- **Meaning and fit:** “support layer + invariant”; a durable control surface
  below agent runtimes.
- **Strengths:** distinctive, compact, and clean in package-registry checks.
- **Weaknesses:** the exact GitHub handle is occupied; an active author uses
  the identity; the consonant cluster weakens pronunciation and spelling; the
  name has a fantasy tone.
- **Package proposal:** `@talvryn/contracts`, `@talvryn/worker`,
  `talvryn-worker`, `@talvryn/cli`, and `@talvryn/otel`.
- **Domain patterns:** `.dev`, `.io`, `.com`, `usetalvryn.com`,
  `gettalvryn.dev`, and `talvrynhq.com` returned no exact RDAP record.
- **Collision finding:** the exact [GitHub user](https://github.com/Talvryn)
  and an active [author identity](https://www.royalroad.com/profile/929990) are
  occupied.

## Availability evidence

| Finalist | GitHub exact/close                                                                               | npm exact package paths                                                      | PyPI exact distributions                     | Domain evidence                                                                                          | Exact-name web search                          | Trademark  |
| -------- | ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- | -------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ---------------------------------------------- | ---------- |
| Tenvyr   | No exact account record; one close repo, `Alyas1222/tenvyra.github.io`.                          | No exact record for the unscoped name or three checked scoped package paths. | No exact record for all three checked forms. | No exact RDAP record for `.dev`, `.io`, `.ai`, or `tenvyrhq.com`; `.com` occupied.                       | Gamer handle; no exact software product found. | Unverified |
| Exaryn   | No exact account record; zero name-matching repositories.                                        | No exact record for the unscoped name or three checked scoped package paths. | No exact record for all three checked forms. | No exact RDAP record for `.io`, `.com`, `useexaryn.com`, or `exarynhq.com`; preferred `.dev` unverified. | OCR noise; no meaningful product found.        | Unverified |
| Sutryva  | No exact account record; zero name-matching repositories.                                        | No exact record for the unscoped name or three checked scoped package paths. | No exact record for all three checked forms. | No exact RDAP record for `.dev`, `.io`, `.ai`, or `usesutryva.com`.                                      | No meaningful exact-name result found.         | Unverified |
| Serevon  | No exact account record; two close `Serevona` repositories.                                      | No exact record for the unscoped name or three checked scoped package paths. | No exact record for all three checked forms. | No exact RDAP record for `.dev`, `.io`, `useserevon.com`, or `serevonhq.com`; `.com` occupied.           | Health, music, and creator uses found.         | Unverified |
| Merynt   | Exact personal account occupied; matches include `Meryntopia/Meryntopia` and `merynt/missasset`. | No exact record for the unscoped name or three checked scoped package paths. | No exact record for all three checked forms. | No exact RDAP record for `.io`, `.com`, `usemerynt.com`, or `merynthq.com`.                              | Historical name and handles found.             | Unverified |
| Talvryn  | Exact personal account occupied with `Talvryn/calc`.                                             | No exact record for the unscoped name or three checked scoped package paths. | No exact record for all three checked forms. | No exact RDAP record for `.dev`, `.io`, `.com`, `usetalvryn.com`, `gettalvryn.dev`, or `talvrynhq.com`.  | Active author and music uses found.            | Unverified |

The npm checks covered `<name>`, `@<name>/worker`, `@<name>/contracts`, and
`@<name>/python`. An absent package does not prove the corresponding npm scope
can be created or controlled. The PyPI checks covered `<name>`,
`<name>-worker`, and `<name>-sdk`.

Evidence came from these direct sources:

- GitHub REST:
  `https://api.github.com/users/<name>` and
  `https://api.github.com/search/repositories?q=<name>%20in:name`.
- npm registry:
  `https://registry.npmjs.org/<name>` and the encoded scoped package paths.
- PyPI:
  `https://pypi.org/project/<distribution>/`.
- RDAP:
  `https://rdap.org/domain/<domain>`.
- Exact-name web searches:
  `"<name>"`, `"<name>" AI`, `"<name>" agent`, `"<name>" software`, and
  `"<name>" developer`.

An HTTP 404 or empty result is recorded only as “no exact record found on
2026-07-27.” It does not establish availability.

### Candidate-specific evidence appendix

Every link below was checked on **2026-07-27**. Registry responses can change.
An absent record does not establish availability, and an absent scoped package
does not establish ownership or reservability of the npm scope.

#### Tenvyr

- **GitHub:**
  [exact account](https://api.github.com/users/tenvyr);
  [repository-name search](https://api.github.com/search/repositories?q=tenvyr%20in:name).
- **npm:**
  [unscoped](https://registry.npmjs.org/tenvyr);
  [worker](https://registry.npmjs.org/%40tenvyr%2Fworker);
  [contracts](https://registry.npmjs.org/%40tenvyr%2Fcontracts);
  [python](https://registry.npmjs.org/%40tenvyr%2Fpython).
- **PyPI:**
  [exact](https://pypi.org/project/tenvyr/);
  [worker](https://pypi.org/project/tenvyr-worker/);
  [SDK](https://pypi.org/project/tenvyr-sdk/).
- **RDAP:**
  [tenvyr.dev](https://rdap.org/domain/tenvyr.dev);
  [tenvyr.io](https://rdap.org/domain/tenvyr.io);
  [tenvyr.ai](https://rdap.org/domain/tenvyr.ai);
  [tenvyr.com](https://rdap.org/domain/tenvyr.com);
  [usetenvyr.com](https://rdap.org/domain/usetenvyr.com);
  [gettenvyr.dev](https://rdap.org/domain/gettenvyr.dev);
  [tenvyrhq.com](https://rdap.org/domain/tenvyrhq.com).
- **Exact-name web search:**
  [exact](https://www.google.com/search?q=%22Tenvyr%22);
  [AI](https://www.google.com/search?q=%22Tenvyr%22+AI);
  [agent](https://www.google.com/search?q=%22Tenvyr%22+agent);
  [software](https://www.google.com/search?q=%22Tenvyr%22+software);
  [developer](https://www.google.com/search?q=%22Tenvyr%22+developer);
  the material exact-name result was a
  [gamer handle](https://u.gg/lol/profile/tr1/s2g%20tenvyr-s2g/overview).

#### Exaryn

- **GitHub:**
  [exact account](https://api.github.com/users/exaryn);
  [repository-name search](https://api.github.com/search/repositories?q=exaryn%20in:name).
- **npm:**
  [unscoped](https://registry.npmjs.org/exaryn);
  [worker](https://registry.npmjs.org/%40exaryn%2Fworker);
  [contracts](https://registry.npmjs.org/%40exaryn%2Fcontracts);
  [python](https://registry.npmjs.org/%40exaryn%2Fpython).
- **PyPI:**
  [exact](https://pypi.org/project/exaryn/);
  [worker](https://pypi.org/project/exaryn-worker/);
  [SDK](https://pypi.org/project/exaryn-sdk/).
- **RDAP:**
  [exaryn.dev](https://rdap.org/domain/exaryn.dev);
  [exaryn.io](https://rdap.org/domain/exaryn.io);
  [exaryn.ai](https://rdap.org/domain/exaryn.ai);
  [exaryn.com](https://rdap.org/domain/exaryn.com);
  [useexaryn.com](https://rdap.org/domain/useexaryn.com);
  [getexaryn.dev](https://rdap.org/domain/getexaryn.dev);
  [exarynhq.com](https://rdap.org/domain/exarynhq.com).
- **Exact-name web search:**
  [exact](https://www.google.com/search?q=%22Exaryn%22);
  [AI](https://www.google.com/search?q=%22Exaryn%22+AI);
  [agent](https://www.google.com/search?q=%22Exaryn%22+agent);
  [software](https://www.google.com/search?q=%22Exaryn%22+software);
  [developer](https://www.google.com/search?q=%22Exaryn%22+developer).
  No meaningful exact-name product result was found.

#### Sutryva

- **GitHub:**
  [exact account](https://api.github.com/users/sutryva);
  [repository-name search](https://api.github.com/search/repositories?q=sutryva%20in:name).
- **npm:**
  [unscoped](https://registry.npmjs.org/sutryva);
  [worker](https://registry.npmjs.org/%40sutryva%2Fworker);
  [contracts](https://registry.npmjs.org/%40sutryva%2Fcontracts);
  [python](https://registry.npmjs.org/%40sutryva%2Fpython).
- **PyPI:**
  [exact](https://pypi.org/project/sutryva/);
  [worker](https://pypi.org/project/sutryva-worker/);
  [SDK](https://pypi.org/project/sutryva-sdk/).
- **RDAP:**
  [sutryva.dev](https://rdap.org/domain/sutryva.dev);
  [sutryva.io](https://rdap.org/domain/sutryva.io);
  [sutryva.ai](https://rdap.org/domain/sutryva.ai);
  [sutryva.com](https://rdap.org/domain/sutryva.com);
  [usesutryva.com](https://rdap.org/domain/usesutryva.com);
  [getsutryva.dev](https://rdap.org/domain/getsutryva.dev);
  [sutryvahq.com](https://rdap.org/domain/sutryvahq.com).
- **Exact-name web search:**
  [exact](https://www.google.com/search?q=%22Sutryva%22);
  [AI](https://www.google.com/search?q=%22Sutryva%22+AI);
  [agent](https://www.google.com/search?q=%22Sutryva%22+agent);
  [software](https://www.google.com/search?q=%22Sutryva%22+software);
  [developer](https://www.google.com/search?q=%22Sutryva%22+developer).
  No meaningful exact-name result was found.

#### Serevon

- **GitHub:**
  [exact account](https://api.github.com/users/serevon);
  [repository-name search](https://api.github.com/search/repositories?q=serevon%20in:name).
- **npm:**
  [unscoped](https://registry.npmjs.org/serevon);
  [worker](https://registry.npmjs.org/%40serevon%2Fworker);
  [contracts](https://registry.npmjs.org/%40serevon%2Fcontracts);
  [python](https://registry.npmjs.org/%40serevon%2Fpython).
- **PyPI:**
  [exact](https://pypi.org/project/serevon/);
  [worker](https://pypi.org/project/serevon-worker/);
  [SDK](https://pypi.org/project/serevon-sdk/).
- **RDAP:**
  [serevon.dev](https://rdap.org/domain/serevon.dev);
  [serevon.io](https://rdap.org/domain/serevon.io);
  [serevon.ai](https://rdap.org/domain/serevon.ai);
  [serevon.com](https://rdap.org/domain/serevon.com);
  [useserevon.com](https://rdap.org/domain/useserevon.com);
  [getserevon.dev](https://rdap.org/domain/getserevon.dev);
  [serevonhq.com](https://rdap.org/domain/serevonhq.com).
- **Exact-name web search:**
  [exact](https://www.google.com/search?q=%22Serevon%22);
  [AI](https://www.google.com/search?q=%22Serevon%22+AI);
  [agent](https://www.google.com/search?q=%22Serevon%22+agent);
  [software](https://www.google.com/search?q=%22Serevon%22+software);
  [developer](https://www.google.com/search?q=%22Serevon%22+developer);
  results included a [Swiss health retreat](https://serevon.info/) and a
  [2026 music release](https://open.spotify.com/album/1ONFuG7aFwnxBsFuSpPVXc).

#### Merynt

- **GitHub:**
  [exact account](https://api.github.com/users/merynt);
  [repository-name search](https://api.github.com/search/repositories?q=merynt%20in:name).
- **npm:**
  [unscoped](https://registry.npmjs.org/merynt);
  [worker](https://registry.npmjs.org/%40merynt%2Fworker);
  [contracts](https://registry.npmjs.org/%40merynt%2Fcontracts);
  [python](https://registry.npmjs.org/%40merynt%2Fpython).
- **PyPI:**
  [exact](https://pypi.org/project/merynt/);
  [worker](https://pypi.org/project/merynt-worker/);
  [SDK](https://pypi.org/project/merynt-sdk/).
- **RDAP:**
  [merynt.dev](https://rdap.org/domain/merynt.dev);
  [merynt.io](https://rdap.org/domain/merynt.io);
  [merynt.ai](https://rdap.org/domain/merynt.ai);
  [merynt.com](https://rdap.org/domain/merynt.com);
  [usemerynt.com](https://rdap.org/domain/usemerynt.com);
  [getmerynt.dev](https://rdap.org/domain/getmerynt.dev);
  [merynthq.com](https://rdap.org/domain/merynthq.com).
- **Exact-name web search:**
  [exact](https://www.google.com/search?q=%22Merynt%22);
  [AI](https://www.google.com/search?q=%22Merynt%22+AI);
  [agent](https://www.google.com/search?q=%22Merynt%22+agent);
  [software](https://www.google.com/search?q=%22Merynt%22+software);
  [developer](https://www.google.com/search?q=%22Merynt%22+developer);
  results included historical personal-name references and the occupied
  [GitHub identity](https://github.com/merynt).

#### Talvryn

- **GitHub:**
  [exact account](https://api.github.com/users/talvryn);
  [repository-name search](https://api.github.com/search/repositories?q=talvryn%20in:name).
- **npm:**
  [unscoped](https://registry.npmjs.org/talvryn);
  [worker](https://registry.npmjs.org/%40talvryn%2Fworker);
  [contracts](https://registry.npmjs.org/%40talvryn%2Fcontracts);
  [python](https://registry.npmjs.org/%40talvryn%2Fpython).
- **PyPI:**
  [exact](https://pypi.org/project/talvryn/);
  [worker](https://pypi.org/project/talvryn-worker/);
  [SDK](https://pypi.org/project/talvryn-sdk/).
- **RDAP:**
  [talvryn.dev](https://rdap.org/domain/talvryn.dev);
  [talvryn.io](https://rdap.org/domain/talvryn.io);
  [talvryn.ai](https://rdap.org/domain/talvryn.ai);
  [talvryn.com](https://rdap.org/domain/talvryn.com);
  [usetalvryn.com](https://rdap.org/domain/usetalvryn.com);
  [gettalvryn.dev](https://rdap.org/domain/gettalvryn.dev);
  [talvrynhq.com](https://rdap.org/domain/talvrynhq.com).
- **Exact-name web search:**
  [exact](https://www.google.com/search?q=%22Talvryn%22);
  [AI](https://www.google.com/search?q=%22Talvryn%22+AI);
  [agent](https://www.google.com/search?q=%22Talvryn%22+agent);
  [software](https://www.google.com/search?q=%22Talvryn%22+software);
  [developer](https://www.google.com/search?q=%22Talvryn%22+developer);
  results included an active
  [author identity](https://www.royalroad.com/profile/929990) and the occupied
  [GitHub identity](https://github.com/Talvryn).

## Trademark screening

The preliminary sources were:

- [WIPO Global Brand Database](https://branddb.wipo.int/en/quicksearch)
- [USPTO Trademark Search](https://tmsearch.uspto.gov/search/search-results)
- [EUIPO/TMview](https://www.tmdn.org/tmview/)
- [IP Vietnam public trademark search](https://wipopublish.ipvietnam.gov.vn/wopublish-search/public/trademarks)

The WIPO source presented an anti-automation challenge; the USPTO and TMview
sources did not expose an inspectable result set in this environment; and the
IP Vietnam result endpoint was not fetchable. Therefore, every finalist's
trademark status is **unverified**. No candidate is described as legally safe
or clear in a preliminary search.

This document is a product and engineering screening, not legal advice.
Qualified trademark counsel must run exact and confusing-similarity searches
in the relevant classes and jurisdictions before public adoption. Serevon and
Talvryn warrant extra review because current non-registry commercial or
identity uses were found.

## Recommended identity

| Surface                     | Canonical value                                 |
| --------------------------- | ----------------------------------------------- |
| Product name                | Tenvyr                                          |
| Pronunciation               | `TEN-veer`                                      |
| One-line meaning            | Execution kept within declared intent.          |
| Positioning tagline         | The control plane for governed agent execution. |
| Repository                  | `tenvyr`                                        |
| npm scope                   | `@tenvyr`                                       |
| TypeScript contracts        | `@tenvyr/contracts`                             |
| TypeScript Worker           | `@tenvyr/worker`                                |
| Python distribution         | `tenvyr-worker`                                 |
| Python import               | `tenvyr_worker`                                 |
| Future CLI                  | `@tenvyr/cli`                                   |
| Future telemetry package    | `@tenvyr/otel`                                  |
| Public Worker factory       | `createTenvyrWorker`                            |
| Public Worker type          | `TenvyrWorker`                                  |
| Public Worker config        | `TenvyrWorkerConfig`                            |
| Internal runtime            | `TenvyrWorkerRuntime`                           |
| Environment prefix          | `TENVYR_`                                       |
| Telemetry namespace         | `tenvyr.*`                                      |
| Docker image namespace      | `ghcr.io/<approved-org>/tenvyr-*`               |
| Preferred domain            | `tenvyr.dev`                                    |
| Protocol v2 reserved header | `X-Tenvyr-*`                                    |

The preferred domain, npm scope, GitHub organization or account, repository,
PyPI distribution, and container namespace remain proposals only. None is
recorded here as reserved or verified as controllable by the owner.

Protocol v1 continues to use the four existing `X-AgentWeave-*` HMAC headers.
`X-Tenvyr-*` is reserved for a separately designed protocol v2; it must not be
introduced as an alias or silent wire rename in the branding migration.

## Implementation and owner actions

1. **Implemented locally:** Tenvyr branding, private TypeScript packages,
   imports, both Worker SDKs, `TENVYR_*` examples, User-Agent values, and
   `urn:tenvyr:schema:*` identities. Protocol v1 and persistent deployment
   identifiers remain deliberately unchanged.
2. **Owner action required:** complete counsel-led trademark and
   confusing-similarity clearance.
3. **Owner action required:** confirm and reserve the GitHub identity, npm
   scope, preferred domain, PyPI distribution, and approved container
   organization.
4. **Owner action required:** select the public license. Packages remain
   `private: true` and `UNLICENSED`; no public release is authorized.
5. **Owner action required:** rename the external repository and separately
   approve any npm, PyPI, image, or other public publication.
