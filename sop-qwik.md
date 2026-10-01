# qwik-guvi — Engineering SOP

GUVI marketing + learning frontend on **Qwik / Qwik City (SSR)**. Applies to humans and AI agents. Design system lives in [`DESIGN.md`](./DESIGN.md) and is authoritative for all visual decisions.

**Precedence when rules conflict:** explicit user ask > `DESIGN.md` > this SOP > neighbor code style. Where a rule below is marked ⚠, see [Resolved conflicts](#12-resolved-conflicts).

---

## 1. Stack & Environment

| Item | Value |
| --- | --- |
| Framework | Qwik + Qwik City ⚠ (`package.json` is source of truth) |
| Language | TypeScript strict, ES2017, jsx `@builder.io/qwik` |
| Runtime / build | Node **18.17.0**, Vite 5, npm `legacy-peer-deps` |
| Styling | Tailwind 3.3 + DaisyUI 4 (single `light` theme, primary `#0dba4b`) + scoped CSS |
| Fonts | DM Sans + Jones |
| Heavy libs | `ace`/`monaco`, `mermaid`, `vad-web`+`onnxruntime-web`, `hls.js`/`plyr`, `swiper`, `lottie`, `canvas-confetti`, `jspdf` |
| Integrations | Razorpay, Google OAuth, reCAPTCHA, GTM, Partytown |
| Alias | `~/*` → `./src/*` |

**Env:** all config is public build-time `VITE_*` (non-secret; real secrets live in backends). Never commit `.env` secrets.

| Var | Purpose |
| --- | --- |
| `VITE_API_PATH` / `VITE_GUVI_BACKEND_API` | Go backend (`guvi-backend`) |
| `VITE_AI_INSTRUCTOR_BASE_URL` / `VITE_AI_INSTRUCTOR_WS_URL` | AI instructor REST + WebSocket (`guvi-ai-instructor`) |
| `VITE_RAG_API_URI` | RAG endpoint |
| `VITE_GENAI_API` | GenAI endpoint |
| `VITE_GOOGLE_CLIENT_ID` | Google OAuth |
| `VITE_CAPTCHA_TOKEN` | reCAPTCHA |
| `VITE_GTAG_ID` | GTM |
| `VITE_IMAGE_PREFIX` / `VITE_IMG_PATH` | CDN image base paths |
| `VITE_BASE_PATH` | App base path |

## 2. Architecture

Client → **guvi-unified** (reverse proxy) → this frontend + backends.

| Repo | Role |
| --- | --- |
| `qwik-guvi` (this) | Qwik SSR frontend |
| `guvi-unified` | Reverse proxy / deploy stage (PHP) |
| `guvi-backend` | Core API, `VITE_API_PATH` (Go) |
| `guvi-ai-instructor` | AI LMS: instructor + RAG (Python) |

- **Deploy:** Cloudflare Pages (primary, `npm run deploy`), AWS Lambda, Express, Docker→ECS. **CI = AWS CodeBuild (`buildspec.yml`)**, not GitHub Actions.
- **Surfaces (~60 routes / ~150 components):** marketing (`about`/`faq`/`hub`/`nsdc`) · courses (`courses/[id]`, `category`) · zen-class bootcamps (`common-zen-*`) · practice (`ide`/`code-kata`/`webkata`/`sqlkata`/`monaco-editor`) · skill-assessment · AI instructor (`learn/[courseId]`, `rag`, `rag-genie`, `project-genie`, `dobby`) · referral · B2B (`corporates`/`enterprise`/`gfc-*`/`tech-hiring-*`) · legal · internal tools.
- **AI instructor (active focus):** unified panel `src/routes/learn/[courseId]/components/ai-panel/ai-panel.tsx`, mounted once (commit `790541c3`). WebSocket `${VITE_AI_INSTRUCTOR_WS_URL}/${sessionId}` drives transcript/stream/actions (`play_video`/`show_quiz`/`next_lesson`) + voice (`audiomotion-analyzer`, `MediaRecorder`, `vad-web`). 11-language `LangConfirmModal` persists to `localStorage["ai_instructor_language"]` and **must stay synced with the socket** (source of recent bugs).
- **Docs to read first for architecture questions:** `graphify-out/GRAPH_REPORT.md`. After source edits run `graphify update .`.

## 3. Working Principles

1. **Think first:** state assumptions and tradeoffs; ask when unclear, never silently pick an interpretation.
2. **Minimum code:** only what the ask needs. No speculative flexibility.
3. **Surgical edits:** every line traces to the request; match neighbor style; flag dead code in existing files rather than deleting it.
4. **Goal-driven:** restate the task as a verifiable check before coding; loop until met.
5. **Two attempts, then investigate:** if a fix fails twice, read upstream source and search the web before retrying.
6. **Boil the Lake:** finish the last 10% (edge cases, responsive/loading/error states, a11y, cleanup). No skeletons.
7. **Never alter marketing copy.** Do not modify, rephrase, or "improve" any user-facing text, headings, or labels during UI/layout/refactor work unless explicitly asked.
8. **Portable docs:** repo-relative paths and `github.com/guvi-geek/*` URLs only.

## 4. Component Architecture

- Every page section is a **reusable, self-contained component**, no side effects, no unnecessary outside dependencies.
- Colocate images, CSS, scripts in the component folder: `index.tsx` (or named file) + `?inline` / module CSS + `images/`.
- **Naming:** components PascalCase; files/folders kebab-case; props `…Props`. No barrel re-exports.
- **Exports:** named — `export const Name = component$(() => …)`. No default-export pattern for components (route files that Qwik City requires to default-export are the exception).
- **Lists:** arrays + `.map()`; never duplicate JSX/styles.
- **Unused components you create:** delete or fully comment out (Qwik builds exported components even if unused).
- **Model component:** `src/components/toast/toast.tsx`.

## 5. Styling

- **No inline styles / JSX style props.**
- **Tailwind default utilities only; no arbitrary values** (`w-[313px]` etc.). Prettier auto-sorts classes.
- **Mobile-first:** base = mobile, then `sm:` 576 → `md:` 768 → `lg:` 992 → `xl:` 1200. Avoid `max-width` media queries. Verify at 375/576/768/992/1200.
- **CSS placement:** route-level `*.css`; component-level `*.module.css` / `?inline` with `useStylesScoped$`; `useStyles$` only when styles must cascade across parent/child.
- **Tokens:** on-token colors only. New value → update `tailwind.config.js` + `src/global.css` + `DESIGN.md` together.
- **3 color territories (never mix):** brand green `#0dba4b` (marketing/CTA) · AI purple `#6729ff` (Genie/RAG/instructor/Zen) · practice green-on-dark (`#0ae056`/`#56f68f` on `#0a0f14`, IDE).
- **Type:** h1 2.5rem → h6 1rem, 700/1.2. **Radius:** `0.25rem`. Single light theme.
- **Fonts:** when updating font files, update `@font-face` URLs **and** every preload URL together.

## 6. Images & Assets

- **Never use raw `<img>`.**
- Local: `import Img from './images/x.png?jsx'`.
- CDN: **Unpic Image** with explicit `src`, dimensions, loading priority.
- `<picture>` only when desktop/mobile need completely different images.
- First-fold → high priority. Below-fold → lazy. Load nothing unnecessary.
- **Figma fidelity:** never replace custom Figma assets (stars, badges, checkmarks, illustrations) with Lucide/library icons unless pixel-identical.
- **Preserve `object-fill` / `object-cover`** on background/card illustrations (e.g. `strategic-offerings.tsx`). Never swap to `object-contain`.

## 7. Qwik Code Rules

- **Handlers:** define separately, bind via `onClick$={handler}`. No inline JS/event logic.
- **State:** normal `const` for static data (named constants, outside component); `useSignal` for a single primitive changing on the client; `useStore` for deep reactive objects; `useComputed$` for derived; `noSerialize` for lib instances. **Never Store for static arrays.**
- **Reactions to input:** prefer `onInput$`/`onChange$` over `useTask$`. Avoid unnecessary Signal/Store/Task.
- **Tasks:** prefer `useTask$`. `useVisibleTask$` only for DOM-only work, never first-fold, with `// eslint-disable-next-line qwik/no-use-visible-task`.
- **DOM access:** `useSignal<HTMLElement>()` refs, not IDs.
- **Data/forms:** `routeLoader$` → generated `useX` hooks. **No `routeAction$` / `Form` / `server$`**; forms POST via `post()` in `~/utils/steroid`.
- **Navigation:** no client-side navigation between routes. Allowed only inside sub-routes that genuinely need an app-like client experience (e.g. code-kata).
- **Lint/TS:** single quotes (error), 2-space, LF; `no-unused-vars` error; `consistent-type-imports` warn; `no-explicit-any` is off — still avoid it. Do not disable lint rules without manager approval (only the sanctioned `useVisibleTask$` line above).

## 8. Performance & Accessibility

- **Initial load ships no JS except Qwik's default module-preload.** Keep first-fold static / server-rendered.
- **Targets (Lighthouse/PageSpeed, mobile + desktop):** 95+ best case, **90+ minimum. Below 90 is not complete.** Performance is a development requirement.
- Dynamic-import heavy libs at point of use. Measure with `benchmark`.
- **Dependencies:** no new packages without senior approval; evaluate each by final-page impact; **never change dependency versions.**
- **Motion:** GPU-only (`translate`/`scale`/`opacity`); never animate layout props on the main path. **Exception:** accordions/collapsibles (FAQ) may transition `grid-template-rows` `0fr↔1fr` + needed padding — keep them.
- **A11y:** WCAG AA contrast; always-visible focus rings (never bare `outline:none`); honor `prefers-reduced-motion`; touch targets ≥44px; no orphan hover on touch.

## 9. Workflow (gates mandatory)

| Step | Action |
| --- | --- |
| Brainstorm | `brainstorming` for any new feature/behavior |
| **Gate 1** (pre-implementation) | `plan-eng-review`, iterate until it passes |
| UI / page / component | **1)** `frontend-design`: read `DESIGN.md`; ≥3 passes — *P1* structure + tokens + real content, dense but clutter-free · *P2* states, motion, responsive, verify light theme · *P3* depth + microinteractions, GPU-only, reduced-motion safe. Qwik+TS directly, no HTML intermediate. **2)** `design-review` delegated to a **fresh `general-purpose` agent with no prior context**; debate findings with the user before fixing |
| API / data layer / new service | Implement from spec + `test-driven-development`; coordinate `guvi-backend` / `guvi-ai-instructor` |
| Tests | TDD: RED → GREEN → REFACTOR |
| Bugs | `systematic-debugging` / `investigate` (4 phases, no ad-hoc patching) |
| **Gate 2** (post-implementation) | `review`; fix every finding before DONE |
| Before DONE | `verification-before-completion` |
| Before PR | `review` + `cso` |
| After deploy | `qa` + `canary` |

Small work passes both gates too; it is just cheap.

**Testing reality:** effectively untested (1 stale Playwright spec, 0 unit tests, CI runs none). Do not treat the suite as a safety net; add real tests via TDD and validate surfaces with `qa`/`design-review`.

## 10. Git, Build & Release

1. Branch off `development` (topic/person-scoped).
2. Before final push: **merge/rebase latest `development`**, resolve all conflicts, re-verify.
3. Run `npm run build` (must pass) and `build.types && lint && fmt.check`.
4. Push. Never `--force`, `reset --hard`, or `stash` shared work.
5. Commits/PRs: plain descriptive messages, **no AI-tool attribution** (no "Generated with…", Co-Authored-By, footers).
6. Screenshots go in a gitignored dir (e.g. `.screenshots/`) and are deleted when done.

**Commands:** `dev`/`start` · `build.types` · `build.production` (typecheck+client+Cloudflare+lint) · `deploy` · `serve` · `lint` · `fmt`/`fmt.check` · `test.unit` · `test.e2e`.

**Completion status:** end every task with **DONE** (with evidence) / **DONE_WITH_CONCERNS** / **BLOCKED** / **NEEDS_CONTEXT**.

## 11. Final Review Checklist

**Structure**
- [ ] Sections are reusable, self-contained; assets colocated
- [ ] No unused components; no duplicated list JSX/styles
- [ ] Named exports; kebab-case files; no barrels

**Styling**
- [ ] No inline styles; no arbitrary Tailwind values
- [ ] Mobile-first; checked at 375/576/768/992/1200
- [ ] On-token colors; correct territory; `DESIGN.md` updated if new value
- [ ] Marketing copy untouched

**Images**
- [ ] No `<img>`; local `?jsx`; CDN via Unpic with size + priority
- [ ] First-fold high priority; below-fold lazy
- [ ] Figma assets and `object-fit` preserved

**Code**
- [ ] Handlers defined separately; no inline JS
- [ ] No unnecessary Signal/Store/Task/`useVisibleTask$`; static data is plain `const`
- [ ] No client-side nav between routes; no `routeAction$`/`server$`
- [ ] No disabled lint rules; no unapproved packages; no version changes

**Quality**
- [ ] AA contrast, focus rings, reduced-motion, ≥44px targets
- [ ] No JS on initial load beyond Qwik preload
- [ ] Lighthouse ≥90 (target 95) mobile + desktop
- [ ] Gates 1 & 2 passed; `development` merged; `npm run build`, `build.types`, `lint`, `fmt.check` pass

## 12. Project Docs Index

[`README.md`](./README.md) (Qwik quick-start) · [`DESIGN.md`](./DESIGN.md) (design system) · [`AGENTS.md`](./AGENTS.md) / [`GEMINI.md`](./GEMINI.md) (pointers to this file) · `graphify-out/GRAPH_REPORT.md` (architecture) · siblings: [guvi-unified](https://github.com/guvi-geek/guvi-unified) · [guvi-backend](https://github.com/guvi-geek/guvi-backend) · [guvi-ai-instructor](https://github.com/guvi-geek/guvi-ai-instructor).
