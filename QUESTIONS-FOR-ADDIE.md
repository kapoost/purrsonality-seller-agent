# Pytania do Addie (AAO MCP)

**Endpoint:** `https://agenticadvertising.org/mcp` (OAuth z AAO email lub WorkOS API key)
**Kontekst:** Production-grade seller agent on `@adcp/sdk` 7.7.0, 117/4/54 storyboards passing po 1 sesji. Pytania dotyczą 4 deferred failures + roadmap fit.

Addie woli krótkie odpowiedzi — pytania są sformułowane "transactionally" (krótkie, konkretne). Jeśli wymagają depth, ona sama rozwinie.

---

## Blok A — 4 deferred failures (czy to wskazany approach?)

### 1. comply_controller_mode_gate/deny_live_caller
Mój `sandboxGate: (input) => input.account?.sandbox !== false` zwraca `false` dla live caller — SDK respond z HTTP 403, ale test expects MCP body matching `comply-test-controller-response.json` (ControllerError branch). Czy istnieje wzorzec żeby SDK zwracał MCP-shaped ControllerError zamiast HTTP 403 przy denial gate?

### 2. security_baseline/assert_mechanism
`Probe validations failed.` Mam `verifyApiKey` z Bearer token. Czy `auth_mechanism_verified` wymaga PRM (RFC 9728) + auth-server metadata (RFC 8414) endpointów, czy istnieje uproszczony wzorzec dla API-key-only sellerów per `connect-addie.mdx` mention "API-key-only agents don't need to advertise RFC 9728 PRM"?

### 3. v3_envelope_integrity/no_legacy_status_fields
Test sprawdza `/status` field na `get_adcp_capabilities` response envelope. SDK auto-generuje response BEZ `status` field. Czy to bug w SDK 7.7.0 czy ja powinienem wstrzyknąć status w middleware preTransport?

### 4. create_media_buy_async/create_media_buy_submitted
Test używa `force_create_media_buy_arm` controller directive żeby pre-rejestrować `task_id`. Mój `ctx.handoffToTask(fn)` mintuje fresh task_id. Czy `TaskHandoffOptions.task_id` powinien być automatycznie wypełniony przez framework z controller directive, czy adopter musi czytać directive z `ctx` ręcznie?

---

## Blok B — Roadmap fit

### 5. Signal provider reference
Mam claimed `signal-marketplace` w sellerze (6 sygnałów Purrsonality, ale spec ma `signal-owned` i `signal-marketplace` jako odrębne specialism). Czy `signal-owned` (publisher własne sygnały) jest bardziej trafny dla setupu single-publisher? Czy jest reference impl signal agent (osobny od seller)?

### 6. Best-practice stack dla seller na edge
Buduje na **Bun 1.3 + @adcp/sdk 7.7.0**. SDK is Node CommonJS — chodzi. Czy AAO widziało innych adopterów na Bun / Workers / Deno? Czy są reference deployments (Cloud Run / Fly / k8s) z których mogę się uczyć?

### 7. Multi-tenant isolation dla forków
Mam `mockUpstream` jako module-singleton, OK dla single Purrsonality. Przy forkach (WPP, Magnite, retail media) → potrzeba per-tenant isolation. Czy SDK ma rekomendowany pattern (Postgres schema-per-tenant, separate process, namespace) czy każdy adopter rozwiązuje sam?

---

## Blok C — Process / community

### 8. Compliance fork-matrix dla adopterów
Czy AAO publikuje compliance scores adopterów? Czy 117/4/54 z `storyboard run` to publishable metric (per `--no-allow-http` produkcyjny) gdy podpiszę agent przez RFC 9421?

### 9. Working group fit dla nowego specialism
Mam pomysł na specialism który nie istnieje (rozproszony adserver "nowej ery" — globalny scale, edge-anycast). Czy zgłasza się do `wg-builders` czy do specific protocol WG? Jak wygląda flow `RFC issue → working draft → spec PR`?

### 10. Forki dużych wydawców — case studies
Spodziewam się forków od dużych wydawców (WPP, Magnite, holdco hubs). Czy AAO ma case studies adopcji forks/holdco? Co poszło źle / dobrze przy pierwszych implementacjach?

---

## Format odpowiedzi które oczekuję

Po Addie response — przynieś z powrotem do tej sesji jako:
- **Skrót decyzyjny:** które z 4 deferred faktycznie mam fix-ować vs accept jako "spec gap"
- **Linki:** doc URLs, GitHub issues, code references jakie poda
- **Surprising:** cokolwiek co zmienia moje założenia (np. "ta sesja overengineering — wystarczy 80/20")

Save jej odpowiedzi do `agents/seller/ADDIE-RESPONSE.md` (gitignore'owane bo personal).
