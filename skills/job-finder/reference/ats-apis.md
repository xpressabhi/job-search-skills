# ATS / job-board JSON APIs — verified reference

Compiled 2026-09-15 for `job-finder` sweeps. Every "Verified" is the HTTP status of a live `curl`
request made that day (desktop Chrome User-Agent, no cookies) against the real tenant named in
parentheses. Endpoints marked **official** have vendor documentation; endpoints marked
**community** have no official docs and are documented by scrapers/users — those are the ones that
can change without notice.

## Summary

| ATS | List endpoint | Auth | Key fields | Verified (code, tenant) | Source |
|---|---|---|---|---|---|
| Greenhouse | `GET https://boards-api.greenhouse.io/v1/boards/{token}/jobs?content=true` | none | `id`, `title`, `updated_at`, `first_published`, `location.name`, `absolute_url`, `metadata[]`, `content` | 200 (anthropic, 596 jobs) | official |
| Ashby | `GET https://api.ashbyhq.com/posting-api/job-board/{org}?includeCompensation=true` | none | `title`, `location`, `secondaryLocations[]`, `publishedAt`, `jobUrl`, `applyUrl`, `isListed`, `isRemote`, `workplaceType`, `employmentType`, `compensation{}` | 200 (openai, 808 jobs) | official |
| Lever | `GET https://api.lever.co/v0/postings/{co}?mode=json` (EU: `api.eu.lever.co`) | none | `text`, `categories.{location,commitment,team,allLocations}`, `createdAt`, `hostedUrl`, `applyUrl`, `workplaceType`, `salaryRange{}` | 200 (palantir, 314 jobs) | official |
| Workable | `GET https://apply.workable.com/api/v1/widget/accounts/{sub}?details=true` (or `POST .../api/v3/accounts/{sub}/jobs`) | none | `title`, `shortcode`, `city/state/country`, `telecommuting`, `employment_type`, `published_on`, `url`/`application_url`, `department` | 200 (huggingface, 6 jobs; v1 and v3) | community (official API is key-gated) |
| SmartRecruiters | `GET https://api.smartrecruiters.com/v1/companies/{id}/postings?limit=&offset=` | none | `name`, `releasedDate`, `location{...,remote,hybrid}`, `ref`, `typeOfEmployment`, `department`, `experienceLevel` | 200 (BoschGroup 4821, Ubisoft2 278) | official |
| Workday | `POST https://{host}/wday/cxs/{tenant}/{site}/jobs` | none | `total`, `jobPostings[].{title,externalPath,locationsText,postedOn,bulletFields}`; detail: `jobPostingInfo{jobDescription,startDate,location,timeType,jobReqId}` | 200 (nvidia, total 2000) | community |
| iCIMS | classic: none (HTML only). Jibe sites: `GET https://{career-domain}/api/jobs?limit=&page=` | none (Jibe) / partner-gated (`api.icims.com`) | `req_id`, `title`, `location_name`, `posted_date`, `apply_url`, `category[]`, `full_location` | 200 (careers.costco.com, totalCount 20036); classic `/jobs/search` = HTML | official (partner-only) + community |
| BambooHR | `GET https://{sub}.bamboohr.com/careers/list` (+ `/careers/{id}/detail`) | none | `jobOpeningName`, `departmentLabel`, `employmentStatusLabel`, `location{city,state}`, `atsLocation`, `isRemote`, `locationType`; detail adds `datePosted`, `compensation`, `jobOpeningShareUrl` | 200 (g2, 2 jobs; detail 200) | community |
| Recruitee | `GET https://{sub}.recruitee.com/api/offers/` | none | `title`, `department`, `city`, `locations[]`, `remote`, `hybrid`, `published_at`, `careers_url`, `salary{}` | 200 (publitas 8, bunq 16) | official |
| Personio | `GET https://{sub}.jobs.personio.de/xml?language=en` | none | `position`: `id`, `name`, `office`, `additionalOffices`, `department`, `employmentType`, `seniority`, `schedule`, `createdAt`, `jobDescriptions` | 200 (personio, on `.de` and `.com` hosts) | official |
| Teamtailor | `GET https://{sub}.teamtailor.com/jobs.json` (or `.rss`) | none | `items[].{title,url,date_published,content_html,_jobposting{datePosted,jobLocation,hiringOrganization}}` | 200 (career.teamtailor.com, 12 items; `.rss` 200) | community (official REST API is key-gated) |
| HN Algolia | `GET https://hn.algolia.com/api/v1/search_by_date?tags=story,author_whoishiring`; comments: `tags=comment,story_{id}` | none | `objectID`, `title`, `created_at`, `comment_text`, `author` | 200 (Sept 2026 thread `49522897`, 397 comments) | official |
| RemoteOK | `GET https://remoteok.com/api` | none (link-back ToS) | `company`, `position`, `location`, `date`, `url`, `salary_min`, `salary_max`, `tags` | 200 (100 items; element `[0]` is the ToS notice) | official endpoint |
| Remotive | `GET https://remotive.com/api/remote-jobs?category=&limit=` | none | `title`, `company_name`, `candidate_required_location`, `publication_date`, `url`, `salary`, `job_type` | 200 | official endpoint |
| Himalayas | `GET https://himalayas.app/jobs/api?limit=&offset=` | none | `title`, `companyName`, `locationRestrictions[]`, `pubDate`, `applicationLink`, `minSalary`/`maxSalary`, `seniority` | 200 (20/page, `nextCursor`) | official endpoint |
| We Work Remotely | RSS only: `GET https://weworkremotely.com/categories/remote-programming-jobs.rss` | none | RSS 2.0 items (`title`, `link`, `pubDate`, `region`) | 200 | official feed |

---

## 1. Greenhouse Job Board API — official

- List: `GET https://boards-api.greenhouse.io/v1/boards/{board_token}/jobs`
- With descriptions: append `?content=true` (adds `content`, `departments[]`, `offices[]`)
- Single job: `GET .../jobs/{job_id}?questions=true&pay_transparency=true` (pay ranges exist only here)
- Auth: none for GET ("Job Board data is publicly available"); only application `POST` needs Basic auth.
- Pagination: none — one response returns the whole board; sanity-check `meta.total`.
- Response: `{"jobs":[...],"meta":{"total":N}}`. Job fields: `id`, `internal_job_id`, `title`,
  `updated_at`, `first_published` (list with `content=true`), `requisition_id`, `location.name`,
  `absolute_url`, `language`, `metadata[]` (custom fields, e.g. "Location Type"), and with
  `content=true` also `content`, `departments`, `offices`, `data_compliance`, `ai_disclaimer*`.

Verified:
```bash
curl -s -o gh.json -w "%{http_code}" \
  "https://boards-api.greenhouse.io/v1/boards/anthropic/jobs?content=true"
# 200 — 596 jobs; meta.total 596
curl -s -o /dev/null -w "%{http_code}" \
  "https://boards-api.greenhouse.io/v1/boards/zzzz-not-a-real-board-xyz/jobs"
# 404 {"status":404,"error":"Job not found"}
```

Rate limits: none documented. `boards-api.greenhouse.io/robots.txt` = `User-agent: * / Disallow: /embed/`
(everything else allowed). Source: https://developers.greenhouse.io/job-board.html

## 2. Ashby Posting API — official

- `GET https://api.ashbyhq.com/posting-api/job-board/{JOB_BOARD_NAME}?includeCompensation=true`
- `JOB_BOARD_NAME` = last path segment of `https://jobs.ashbyhq.com/{name}`.
- Auth: none. Pagination: none — full board in one GET.
- Response: `{"apiVersion":"1","jobs":[...]}`. Fields: `id`, `title`, `department`, `team`,
  `employmentType` (FullTime/PartTime/Intern/Contract/Temporary), `location`, `secondaryLocations[]`,
  `publishedAt` (ISO), `isListed`, `isRemote`, `workplaceType` (OnSite/Remote/Hybrid), `address`,
  `jobUrl`, `applyUrl`, `descriptionHtml`, `descriptionPlain`; with `includeCompensation=true` each
  job also gets `compensation{compensationTierSummary, scrapeableCompensationSalarySummary,
  compensationTiers[], summaryComponents[]}` and `shouldDisplayCompensationOnJobPostings`.

Verified:
```bash
curl -s -o ashby.json -w "%{http_code}" \
  "https://api.ashbyhq.com/posting-api/job-board/openai?includeCompensation=true"
# 200 — 808 jobs
curl -s -o /dev/null -w "%{http_code}" \
  "https://api.ashbyhq.com/posting-api/job-board/zzzz-not-a-real-org-xyz"
# 404
```

Caveats: `isRemote` can be `null` in practice (verified on OpenAI data) — prefer `workplaceType`;
filter `isListed=false` client-side; large boards mean a multi-MB response.
Rate limits: none documented. Source: https://developers.ashbyhq.com/docs/public-job-posting-api

## 3. Lever Postings API — official

- `GET https://api.lever.co/v0/postings/{company}?mode=json` (EU instances: `https://api.eu.lever.co/...`)
- Auth: none for GET. Pagination: `?skip=N&limit=N`; filters: `location`, `commitment`, `team`,
  `department`, `level` (repeatable, OR'ed, case-sensitive).
- Response: JSON array. Fields: `id`, `text` (title), `categories{location, team, commitment,
  allLocations}`, `country` (ISO-3166 alpha-2), `createdAt` (epoch ms), `updatedAt`, `hostedUrl`,
  `applyUrl`, `workplaceType` (unspecified/on-site/remote/hybrid), `salaryRange{currency,interval,min,max}`
  (optional), `salaryDescriptionPlain`, `descriptionPlain`, `additionalPlain`, `lists[]`.

Verified:
```bash
curl -s -o lever.json -w "%{http_code}" \
  "https://api.lever.co/v0/postings/palantir?mode=json"
# 200 — 314 jobs
curl -s -o lever2.json -w "%{http_code}" \
  "https://api.lever.co/v0/postings/palantir?mode=json&skip=1&limit=3"
# 200 — 3 jobs
curl -s -o /dev/null -w "%{http_code}" \
  "https://api.lever.co/v0/postings/zzzz-not-a-real-company-xyz?mode=json"
# 404 {"ok":false,"error":"Document not found"}
```

Rate limits: only the application `POST` is documented as limited (2/sec, `429` handling required);
no list limit documented. `api.lever.co/robots.txt` = `Allow: /` + `Crawl-delay: 1`. Docs explicitly
state published postings "may be scraped by third parties". Browser CORS is restricted to the
company's own domains — irrelevant for server-side sweeps. Note: no full-text search.
Source: https://github.com/lever/postings-api

## 4. Workable — public widget/v3 endpoints (undocumented), official API is key-gated

- Widget (GET, simplest): `GET https://apply.workable.com/api/v1/widget/accounts/{sub}?details=true`
  (`details=true` adds full `description`). One call = whole board, no pagination observed.
- Internal v3 (POST, paginated): `POST https://apply.workable.com/api/v3/accounts/{sub}/jobs`
  body: `{"query":"","token":null,"department":[],"location":[],"workplace":[],"worktype":[]}`
  → `{"total":N,"results":[...],"nextPage":"<token|null>"}` (loop passing `nextPage` as `token`).
- Auth: none on both. `careers_url` sub = `https://apply.workable.com/{sub}/`.
- Widget fields: `name` (company), `description`, `jobs[]` with `title`, `shortcode`, `code`,
  `department`, `city`, `state`, `country`, `telecommuting` (bool remote flag), `employment_type`,
  `published_on`, `created_at`, `url`, `application_url`, `shortlink`, `locations[]` (v3: structured
  `location{country,countryCode,city,region}`, `remote`, `workplace`, `type`, `published`).
- The legacy `https://www.workable.com/api/accounts/{sub}` 302-redirects to `apply.workable.com`.
- Official docs cover only the **authenticated per-account** API (`https://{sub}.workable.com/spi/v3/`,
  bearer token; a "Job Board API" key is minted inside one customer's admin) — there is no official
  cross-tenant key. The widget/v3 JSON above is what Workable's own careers pages call.

Verified:
```bash
curl -s -o wk.json -w "%{http_code}" \
  "https://apply.workable.com/api/v1/widget/accounts/huggingface?details=true"
# 200 — {"name":"Hugging Face",...,"jobs":[...6...]}
curl -s -o wk3.json -w "%{http_code}" -X POST \
  "https://apply.workable.com/api/v3/accounts/huggingface/jobs" \
  -H "Content-Type: application/json" \
  -d '{"query":"","token":null,"department":[],"location":[],"workplace":[],"worktype":[]}'
# 200 — {"total":6,"results":[...],"nextPage":null}
curl -s -o /dev/null -w "%{http_code}" \
  "https://apply.workable.com/api/v1/widget/accounts/zzzz-not-a-real-board-xyz"
# 404
```
`apply.workable.com/robots.txt`: `User-agent: *`, `Content-Signal: search=yes, ai-input=yes, ai-train=no`,
empty `Disallow:` (all paths allowed). Sources: https://help.workable.com/hc/en-us/articles/115013356548-Workable-API-Documentation
(official, key-gated API) + https://conorscode.github.io/ats-api-reference/ (community verification of the widget endpoint).

## 5. SmartRecruiters Posting API — official

- `GET https://api.smartrecruiters.com/v1/companies/{companyIdentifier}/postings`
  query: `q`, `limit`, `offset`, `country`, `region`, `city`, `department`, `language`,
  `custom_field.{id}`.
- `companyIdentifier` = the id at the end of `https://careers.smartrecruiters.com/{id}`.
- Auth: none needed for public postings (docs describe API-key/OAuth only for *internal* postings).
- Pagination: `offset`/`limit` (default limit 100). Response: `{offset, limit, totalFound, content[]}`.
- Fields: `id`, `uuid`, `name`, `releasedDate` (ISO), `ref` (detail URL), `location{city, region,
  country, remote, hybrid, fullLocation, latitude, longitude}`, `department{}`, `function{}`,
  `industry{}`, `typeOfEmployment{id,label}`, `experienceLevel{}`, `company{identifier,name}`.
- Detail: `GET .../postings/{id}` adds `jobAd.sections.{companyDescription,jobDescription,
  qualifications,additionalInformation}` and `applyUrl`.

Verified:
```bash
curl -s -o sr.json -w "%{http_code}" \
  "https://api.smartrecruiters.com/v1/companies/BoschGroup/postings?limit=2&offset=2"
# 200 — {"offset":2,"limit":2,"totalFound":4820,"content":[...]}
curl -s -o /dev/null -w "%{http_code}" \
  "https://api.smartrecruiters.com/v1/companies/Atlassian/postings"
# 200 — {"offset":0,"limit":100,"totalFound":0,"content":[]}   <-- trap, see Notes
```

Sources: https://developers.smartrecruiters.com/docs/posting-api and
https://developers.smartrecruiters.com/docs/endpoints

## 6. Workday CXS API — **community-documented**, POST-only

No official public API exists; this is the JSON the careers site's own frontend calls.

- List (POST): `POST https://{host}/wday/cxs/{tenant}/{site}/jobs`
  body: `{"appliedFacets":{},"limit":20,"offset":0,"searchText":""}`
- Tenant discovery from a careers URL: `https://nvidia.wd5.myworkdayjobs.com/en-US/NVIDIAExternalCareerSite`
  → host `nvidia.wd5.myworkdayjobs.com`, tenant `nvidia`, site `NVIDIAExternalCareerSite`
  (strip locale segment `en-US`; datacenter shard `wd1|wd3|wd5|wd103|…` is per customer).
- Response: `{total, jobPostings[], facets[], userAuthenticated}` where each posting has `title`,
  `externalPath`, `locationsText`, `postedOn` (**relative string**, e.g. "Posted Today"),
  `bulletFields[]` (requisition id).
- Pagination: `limit`/`offset` until `offset >= total`. A **2,000-result cap** is reported by
  community projects for very large tenants (NVIDIA returned `total: 2000` exactly — almost
  certainly capped); split by facet (`jobFamilyGroup`, etc.) if you need the rest.
- Detail (GET, JSON): `GET https://{host}/wday/cxs/{tenant}/{site}{externalPath}` →
  `jobPostingInfo{title, jobReqId, jobPostingId, jobDescription (HTML), startDate (real ISO date),
  location, additionalLocations[], timeType, remoteType, externalUrl, postedOn}`. Send
  `Accept: application/json`. Public job URL: `https://{host}/en-US/{site}{externalPath}`.
- GET on the list URL returns `400` — POST is required (verified).

Verified:
```bash
curl -s -o wd.json -w "%{http_code}" -X POST \
  "https://nvidia.wd5.myworkdayjobs.com/wday/cxs/nvidia/NVIDIAExternalCareerSite/jobs" \
  -H "Content-Type: application/json" \
  -d '{"appliedFacets":{},"limit":20,"offset":0,"searchText":""}'
# 200 — {"total":2000,"jobPostings":[{"title":"SONiC Software Engineer - Python",
#         "externalPath":"/job/Israel-Raanana/SONiC-Software-Engineer---Python_JR2017236",
#         "locationsText":"Israel, Raanana","postedOn":"Posted Today",
#         "bulletFields":["JR2017236"]}, ...20 items ...],"facets":[...],"userAuthenticated":false}

curl -s -o wdd.json -w "%{http_code}" -H "Accept: application/json" \
  "https://nvidia.wd5.myworkdayjobs.com/wday/cxs/nvidia/NVIDIAExternalCareerSite/job/Israel-Raanana/SONiC-Software-Engineer---Python_JR2017236"
# 200 — jobPostingInfo.startDate "2026-09-15", jobReqId "JR2017236", location "Israel, Raanana", timeType "Full time"

curl -s -o /dev/null -w "%{http_code}" -X GET \
  "https://nvidia.wd5.myworkdayjobs.com/wday/cxs/nvidia/NVIDIAExternalCareerSite/jobs"
# 400
```

Community sources: https://jobspipe.dev/blog/workday-api-guide ·
https://dev.to/udaninn/workday-job-boards-have-a-json-api-too-its-just-better-hidden-23fl ·
https://github.com/colophon-group/jobseek/blob/143aa449/apps/crawler/src/core/monitors/workday.py ·
https://github.com/lubobali/JobRadar-AI/blob/860dcae5/src/jobradar/fetchers/workday.py ·
https://cleanjobdata.com/articles/how-to-scrape-workday-job-listings
(Additional reported gotchas: Akamai bot management on some tenants; some tenant slugs use `-` in DNS
but `_` in API paths (422 → retry with underscore); no salary field; 2 calls per job for description.)

## 7. iCIMS — no public JSON API for classic tenancy; public JSON on Jibe-powered sites

- **Classic `careers-{co}.icims.com`: no public JSON listing API.**
  `/jobs/search?ss=1` and `/jobs/intelliservices` return `text/html` (verified 200 on
  `careers-rambus.icims.com`). A public `sitemap.xml` does exist (`200`, `text/xml`) and lists live
  job URLs, so classic tenants are an HTML-scrape/sitemap path, one parser per employer.
- **Official iCIMS API is partner/customer-gated**: Job Portal API
  `GET https://api.icims.com/customers/{customerId}/search/portals/{portal}` with HTTP Basic auth —
  no self-serve keys, no public sandbox.
- **Modern iCIMS/Jibe career sites are public JSON**: `GET https://{career-domain}/api/jobs?limit=&page=`
  → `{jobs:[{data:{...}}], locations, totalCount, count, request_id, filter}` with per-job
  `req_id`, `title`, `location_name`, `posted_date`, `apply_url`, `category[]`, `full_location`,
  `description`, `hiring_organization`, `latitude`/`longitude`. Pagination: `page`/`limit`
  (page 1 vs 2 return different jobs; default page size 10).

Verified:
```bash
curl -s -o /dev/null -w "%{http_code} %{content_type}\n" \
  "https://careers-rambus.icims.com/jobs/intelliservices"
# 200 text/html;charset=UTF-8   (HTML, not JSON)
curl -s -o /dev/null -w "%{http_code} %{content_type}\n" \
  "https://careers-rambus.icims.com/sitemap.xml"
# 200 text/xml;charset=UTF-8
curl -s -o jibe.json -w "%{http_code}" \
  "https://careers.costco.com/api/jobs?limit=2&page=1"
# 200 — {"jobs":[{"data":{"req_id":"67761","title":"Membership Clerk",
#         "location_name":"N KATY - TX - 00001807","posted_date":"2026-09-03T20:30:00+0000",
#         "apply_url":"...","category":[" Warehouses and Business Associates"]}}],
#         "totalCount":20036,...}
```

Sources: https://developer-community.icims.com/applications/applicant-tracking/job-portal (official,
partner-gated) · https://jobspipe.dev/guides/icims-jobs-api ·
https://apify.com/benthepythondev/icims-jobs-scraper (Jibe `/api/jobs`) ·
https://github.com/johnisanerd/Apify-iCIMS-Careers-API

## 8. Smaller ATSes

### BambooHR — community-documented
- `GET https://{sub}.bamboohr.com/careers/list` → `{meta:{totalCount}, result:[...]}`; no pagination.
  Fields: `id`, `jobOpeningName`, `departmentLabel`, `employmentStatusLabel`, `employmentType`,
  `location{city,state}`, `atsLocation{...}`, `isRemote`, `locationType`.
- `GET https://{sub}.bamboohr.com/careers/{id}/detail` → `result.jobOpening{datePosted, compensation,
  minimumExperience, description, jobOpeningShareUrl}` (salary only here).
- `GET https://{sub}.bamboohr.com/careers/company-info` validates the tenant and returns name + logo.
- No auth. Missing tenant 302-redirects to `www.bamboohr.com` marketing (community report) — validate
  the payload shape (`result` array), not just the status code.

Verified:
```bash
curl -s -o bh.json -w "%{http_code}" "https://g2.bamboohr.com/careers/list"
# 200 — {"meta":{"totalCount":2},"result":[{"id":"156","jobOpeningName":"Tractor Trailer Operator",...}]}
curl -s -o bhd.json -w "%{http_code}" "https://g2.bamboohr.com/careers/156/detail"
# 200 — jobOpening.compensation "$90,000 - $120,000 annually", datePosted "2026-08-06"
```

Sources: https://jobo.world/ats/bamboohr · https://packagist.org/packages/plin-code/job-boards-bamboohr ·
https://github.com/outscal/OpenJobs/blob/main/probe-ats.mjs

### Recruitee — official careers-site API
- `GET https://{sub}.recruitee.com/api/offers/` (keep the trailing slash). Full board in one call,
  no pagination. Optional filters: `department`, `tag`.
- Fields: `id`, `guid`, `title`, `slug`, `department`, `status`, `city`, `locations[]` (structured,
  full office objects), `remote`, `hybrid`, `on_site`, `published_at`, `careers_url`,
  `careers_apply_url`, `salary{min,max,period,currency}`, `employment_type_code`, `tags[]`.
  Also works on custom domains (`https://{custom-domain}/api/offers/`).

Verified:
```bash
curl -s -o rec.json -w "%{http_code}" "https://publitas.recruitee.com/api/offers/"
# 200 — {"offers":[...8...]}
curl -s -o rec2.json -w "%{http_code}" "https://bunq.recruitee.com/api/offers/"
# 200 — 16 offers; e.g. {"title":"Fraud Operations Analyst - Night Shift","department":"Support & Operations",
#         "city":"İstanbul","remote":false,"hybrid":true,"published_at":"2026-09-15 08:11:57 UTC",
#         "careers_url":"https://careers.bunq.com/o/...","salary":{"min":null,...}}
```
Source: https://docs.recruitee.com/reference/offers

### Personio — official XML feed
- `GET https://{sub}.jobs.personio.de/xml?language=en` (language optional; default `de`; supported
  `de|en|fr|es|nl|it|pt`; `.jobs.personio.com` also works — verified both).
- One XML document with all published positions, no auth, no pagination:
  `<position>` → `id`, `subcompany`, `office`, `additionalOffices`, `department`,
  `recruitingCategory`, `name`, `jobDescriptions{jobDescription[].{name,value}}`,
  `employmentType` (permanent/intern/trainee/freelance), `seniority`, `schedule` (full-time/part-time),
  `yearsOfExperience`, `keywords`, `occupation`, `occupationCategory`, `createdAt`.
- Job page: `https://{sub}.jobs.personio.de/job/{id}`.
- The old `search.json` endpoint is gone: it 307-redirects to `personio.com` and returns 403.

Verified:
```bash
curl -s -o po.xml -w "%{http_code}" "https://personio.jobs.personio.de/xml"
# 200 — <workzag-jobs><position><id>1834171</id>...
curl -s -o /dev/null -w "%{http_code} %{url_effective}\n" -L "https://personio.jobs.personio.de/search.json"
# 307 -> 403 at https://personio.com/
```
Sources: https://developer.personio.de/v1.0/reference/get_xml ·
https://support.personio.de/hc/en-us/articles/207576365-Integrate-jobs-from-Personio-into-your-website-via-XML

### Teamtailor — public career-site feeds (JSON Feed + RSS); official API is key-gated
- Public, no auth: `GET https://{sub}.teamtailor.com/jobs.json` (JSON Feed 1.1). Items:
  `id`, `title`, `url`, `date_published`, `content_html`, and a nested schema.org
  `_jobposting{datePosted, jobLocation, hiringOrganization, description, identifier}`.
- Also `GET https://{sub}.teamtailor.com/jobs.rss` (RSS 2.0). Community reports pagination via
  `?offset=&per_page=` (first 100 by default). Custom-domain career sites (e.g.
  `careers.company.com/jobs.json`) serve the same feed.
- Not every guessed subdomain exists (verified `teamtailor.teamtailor.com/jobs.json` → 404).
- Official REST API `https://api.teamtailor.com/v1/jobs` (also `api.na.teamtailor.com`) requires a
  per-tenant key (`X-Api-Key` + `X-Api-Version`), 50 req/10s, `page[size]` ≤ 30 — not usable for
  multi-company sweeps.

Verified:
```bash
curl -s -o tt.json -w "%{http_code}" "https://career.teamtailor.com/jobs.json"
# 200 — {"version":"https://jsonfeed.org/version/1.1",...,"items":[...12...]}
curl -s -o tt.rss -w "%{http_code}" "https://career.teamtailor.com/jobs.rss"
# 200
```
Sources: https://support.teamtailor.com/en/articles/5963369-use-our-teamtailor-api (official,
key-gated) · https://dev.to/freshactors/how-to-scrape-teamtailor-career-site-jobs-in-python-no-api-key-18ce
(jobs.json, community)

## 9. Aggregators / supplemental discovery

### Hacker News (Algolia) — official
- Latest monthly threads: `GET https://hn.algolia.com/api/v1/search_by_date?tags=story,author_whoishiring`
  → hits with `objectID`, `title`, `created_at` (latest verified: "Ask HN: Who is hiring?
  (September 2026)", `49522897`).
- Comments in a thread: `GET https://hn.algolia.com/api/v1/search?tags=comment,story_{id}`
  (397 hits on the Sept 2026 thread) → `comment_text` (HTML), `author`, `created_at`, `story_title`;
  or fetch the whole tree with `GET https://hn.algolia.com/api/v1/items/{id}`.
- No auth. Docs: https://hn.algolia.com/api

### RemoteOK — official endpoint, attribution required
- `GET https://remoteok.com/api` → one JSON array; **element `[0]` is the ToS notice, not a job**.
- Fields: `company`, `position`, `location`, `date` (ISO), `url`, `apply_url`, `salary_min`,
  `salary_max`, `tags[]`, `description`, `logo`. ~100 items per call (paged via `?limit=`/`?tag=`
  is not documented).
- Embedded legal terms: link back to RemoteOK (follow link, no nofollow), credit Remote OK as the
  source, or API access may be suspended.

Verified:
```bash
curl -s -o rok.json -w "%{http_code}" "https://remoteok.com/api"
# 200 — 100 items; [0].legal = "API Terms of Service: Please link back ... to the URL on Remote OK ..."
```

### Remotive — official endpoint, reposting restrictions
- `GET https://remotive.com/api/remote-jobs?category=software-dev&limit=N`
- Response: `{job-count, total-job-count, jobs[]}`; jobs have `id`, `title`, `company_name`,
  `candidate_required_location`, `publication_date`, `url`, `salary`, `job_type`, `category`,
  `tags[]`, `description`.
- Embedded legal: do **not** repost Remotive jobs to third-party sites (Jooble, Neuvoo, Google Jobs,
  etc.); use the `.com` host (`.io` is being retired).

Verified:
```bash
curl -s -o rem.json -w "%{http_code}" \
  "https://remotive.com/api/remote-jobs?category=software-dev&limit=2"
# 200 — {"job-count":15,"total-job-count":...,"jobs":[{...,"title":"Remote Office Assistant",...}]}
```

### Himalayas — official endpoint
- `GET https://himalayas.app/jobs/api?limit=&offset=` (default page size 20) →
  `{offset, limit, totalCount, nextCursor, jobs[]}`. Cursor pagination is preferred: pass the
  previous `nextCursor` back as `?cursor=`.
- Fields: `title`, `companyName`, `companySlug`, `locationRestrictions[]`, `timezoneRestrictions[]`,
  `pubDate` (epoch), `applicationLink`, `excerpt`, `description`, `employmentType`, `seniority[]`,
  `minSalary`/`maxSalary`/`currency`/`salaryPeriod`, `categories[]`.
- Response includes a `comments` field documenting API changes — read it.

Verified:
```bash
curl -s -o him.json -w "%{http_code}" "https://himalayas.app/jobs/api?limit=2"
# 200 — {"comments":"...cursor pagination...","totalCount":...,"jobs":[...]}
```

### We Work Remotely — RSS only (no JSON API)
- `GET https://weworkremotely.com/categories/remote-programming-jobs.rss` (per-category) and
  `GET https://weworkremotely.com/remote-jobs.rss` (all jobs) → RSS 2.0 (`title`, `link`, `pubDate`,
  `region`, `description`).

Verified:
```bash
curl -s -o wwr.xml -w "%{http_code}" "https://weworkremotely.com/categories/remote-programming-jobs.rss"
# 200
```

---

## Notes & caveats

**Rate limits**
- Documented limits: Lever application `POST` = 2/sec (429 handling required); Teamtailor
  `api.teamtailor.com` = 50 requests/10 s. No documented limits on the public list GET/POST
  endpoints above (Greenhouse, Ashby, Lever GET, SmartRecruiters, Workable, Recruitee, Personio,
  BambooHR). Crawl politely: `api.lever.co/robots.txt` itself asks for `Crawl-delay: 1`, and
  iCIMS/Akamai/Workday tenants run bot protection that responds to aggressive crawling.

**robots / terms**
- `boards-api.greenhouse.io/robots.txt`: allow all except `/embed/`. Greenhouse docs: job board data
  is public; only application POST needs Basic auth.
- `api.lever.co/robots.txt`: `Allow: /`, `Crawl-delay: 1`. Lever's docs explicitly acknowledge that
  published postings "may be scraped by third parties."
- `apply.workable.com/robots.txt`: empty `Disallow:` (all allowed) with `ai-train=no` content signal.
- RemoteOK: attribution is a hard ToS requirement (link back, follow, credit Remote OK).
- Remotive: reuse allowed to "share our jobs further" but reposting to third-party job sites is
  prohibited.
- Ashby/Recruitee/Personio/SmartRecruiters publish these endpoints as their documented careers-page
  APIs, i.e. intended for this use.

**Negative-result traps (tenant validation)**
- SmartRecruiters returns `200` + `totalFound: 0` for unknown company ids (verified `Atlassian`,
  `Visa`, `Bosch`, `IKEA`, `McDonalds` → 0; `BoschGroup` → 4821, `Ubisoft2` → 278, `Atlassian2` → 3).
  Treat a tenant as valid only when `totalFound > 0`.
- BambooHR: a missing tenant 302-redirects to `www.bamboohr.com` marketing HTML — validate the
  `result` array in the body, not the status code.
- Greenhouse, Ashby, Lever, Workable, Recruitee properly return 404 for unknown slugs (verified).

**Endpoint fragility**
- Official/documented (stable): Greenhouse, Ashby, Lever, SmartRecruiters, Recruitee, Personio XML.
- Undocumented but widely used (can change without notice): Workday CXS, Workable widget/v1 + v3,
  BambooHR careers list/detail, Teamtailor `jobs.json`, iCIMS/Jibe `/api/jobs`, classic iCIMS internals.

**Per-ATS gotchas**
- Greenhouse: don't request `content=true` unless you need descriptions — it multiplies payload size;
  pay ranges are only on the single-job endpoint (`?pay_transparency=true`).
- Ashby: `isRemote` can be `null`, filter `isListed`, no pagination (800+ job boards are multi-MB).
- Lever: `createdAt` is epoch ms; no full-text search; browser CORS is domain-restricted.
- Workable: v3 uses an opaque `nextPage` token; the legacy `www.workable.com/api` URL 302s.
- SmartRecruiters: default page size 100; job description requires the per-posting detail call.
- Workday: POST-only (GET → 400); relative `postedOn` in the list, real `startDate` only in the
  detail call; 2,000-result cap on large tenants (facet-split to go beyond); tenant slug
  hyphen/underscore quirks; some hosts behind Akamai.
- iCIMS: classic sites = HTML + `sitemap.xml`, one parser per employer; the official API is
  partner-gated; only Jibe-powered sites expose public `/api/jobs` JSON.
- Personio: XML only (`search.json` dead); language param changes the feed.
- Teamtailor: only career-site feeds are key-free; the official REST API needs a per-tenant key.
- Aggregators: RemoteOK `[0]` is a legal notice; HN Algolia "Who is hiring" threads are monthly —
  fetch the latest via `search_by_date` before pulling `comment,story_{id}`.
