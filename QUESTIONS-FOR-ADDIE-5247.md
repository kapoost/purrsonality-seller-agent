# Pytania do Addie (AAO MCP) — #5247 follow-up

**Endpoint:** `https://agenticadvertising.org/mcp` (OAuth z AAO email lub WorkOS API key)
**Data:** 2026-06-01
**Kontekst:** Independent reproduction of upstream adcp#5247 (storyboard runner state accumulation) on a second seller (Purrsonality, `@adcp/sdk` 7.11.0). Variant z opisanego ±3 niedeterminizmu: u nas degradacja jest deterministyczna po pierwszym pełnym runie suite na tym samym procesie. Workaround zaimplementowany seller-side. Pytania transactional jak ostatnio.

---

## TL;DR reproduction (lokalny seller, in-memory mode, ten sam proces)

| Run | Passed | Failed | Skipped | Notes |
|-----|--------|--------|---------|-------|
| 1 (fresh) | **131** | 1 | 53 | baseline |
| 2 (no reset) | 125 | 4 | 56 | trzy nowe failures |
| 3 (no reset) | 125 | 4 | 56 | stabilnie zdegradowany |

Trzy regresje po pierwszym runie:
- `media_buy_seller/create_media_buy_async/create_media_buy_submitted` — `task_id already registered: task_async_signed_io_q2`
- `media_buy_seller/creative_fate_after_cancellation/list_creatives_after_cancel`
- `pagination_integrity/first_page`

Root cause: in-memory state akumuluje się w **pięciu** warstwach jednocześnie:
1. SDK `stateStore` (InMemoryStateStore) — media buys, plans, sessions
2. SDK `idempotencyStore` (memoryBackend) — replay cache
3. SDK `taskRegistry` (createInMemoryTaskRegistry) — **hardcoded `overrideTaskId` collisions**
4. Nasz `mockUpstream` (8 module-level Maps) — seeded products/creatives/orders
5. Nasze `creativesStore` / `impressionsStore` (in-memory fallback gdy DATABASE_URL=null)

`server.compliance.reset()` z SDK pokrywa tylko warstwy 1 + 2. Warstwy 3–5 zostają pollutowane.

---

## Blok A — Diagnostyka (czy nasze rozumienie jest poprawne?)

### 1. Plan dla `taskRegistry` w `server.compliance.reset()`
SDK 7.11.0 `compliance.reset()` jawnie czyści `stateStore.clear()` + `idempotency.clearAll()`, ale NIE dotyka `taskRegistry`. `TaskRegistry` interface nie eksponuje `clear()` / `reset()`. Storyboardy używające hardcodowanych task_id przez `overrideTaskId` (np. `task_async_signed_io_q2`) blokują second run z `task_id already registered`. Czy w 8.x beta planowane jest rozszerzenie `compliance.reset()` o taskRegistry flush? Czy `TaskRegistry` zyska public `clear()`?

### 2. PR #5221 (storyboard window fix, bump do beta.19) — czy tam to było?
Czy "storyboard window fix" w PR #5221 dotyka tego problemu, czy zupełnie innego layer'a? Pytam zanim spróbujemy bump do 8.x beta — chcielibyśmy wiedzieć czy upgrade rozwiąże nam to nativnie.

### 3. Fix 1 vs Fix 2 z #5247 — direction
Brian proponuje Fix 1 (`reset_state` scenario wywoływane przez runner) jako natychmiastowy mitigation, Fix 2 (per-storyboard correlation_id bucketing) jako architecturally correct. Jako adopter — który kierunek warto wspierać kontrybucją testową / reproduction? Czy AAO ma preferencję?

---

## Blok B — Czy nasz workaround jest właściwy wzorzec?

### 4. Admin endpoint vs `comply_test_controller` extension scenario
Zaimplementowaliśmy `POST /api/mock-state/reset` na osobnym ADMIN_PORT (sandbox-gated, bearer-auth). Wywołuje:
```
adcpServer.compliance.reset()          // SDK state + idempotency
mockUpstream.clearAll()                // our mock layer
creativesStore.clearInMemory()         // local store
impressionsStore.clearInMemory()       // local store
resetInMemoryTaskRegistry()            // swap inner via Proxy wrapper
```

Spec mówi: *"Runners and sellers MUST accept unknown scenario strings — new scenarios may be added in additive releases."* Próbowaliśmy najpierw dodać `reset_state` jako extension scenario przez `complyTest` — SDK 7.x dispatcher (`createComplyController`) zwraca `UNKNOWN_SCENARIO` dla wszystkiego poza enum'em w `ComplyControllerConfig` (`seed_*`, `force_*`, `simulate_*`, `query_*`). Czy 8.x luzuje to (np. `customScenarios?: Record<string, Adapter>`), czy zostaje przy admin-side reset jako rekomendowany wzorzec?

### 5. Proxy wrapper na in-memory TaskRegistry
Żeby reset zerował taskRegistry bez restartu procesu (i bez zmiany pointer'a trzymanego przez `AdcpServer`), wrapnęliśmy go w Proxy:
```ts
let inner: TaskRegistry = createInMemoryTaskRegistry();
const proxy = new Proxy({} as TaskRegistry, {
  get: (_t, prop, recv) => Reflect.get(inner as object, prop, recv),
});
// reset() reasignuje inner = createInMemoryTaskRegistry()
```

Powód: implementacja używa undocumented runtime method `_registerBackground` której nie ma w `TaskRegistry` interface — explicit forwarder ją gubi i wywołuje "X is not a function" przy async media buy. Czy to legalny adopter pattern, czy SDK powinno eksponować swappable inner / public reset?

---

## Blok C — Wkład do #5247

### 6. Czy warto dorzucić independent reproduction jako comment pod #5247?
Mamy artefakty (JSON summaries z runs A/B/C/D + sample stderr) pokazujące że Purrsonality (single-publisher, sales-non-guaranteed) eksperymentalnie potwierdza problem opisany przez fgranata na innym sellerze. Plus: dochodzi 3-warstwowa diagnoza (taskRegistry jako trzecie miejsce poza stateStore + mock — fgranata wspomina o `seeded products` i `creative state`, ale nie expicite task_id collisions). Czy AAO chce żeby to wpadło pod issue, czy bardziej osobne issue "compliance.reset() doesn't cover taskRegistry"?

### 7. Test-kit dla "second-run determinism"
Czy test-kit w `compliance/cache/<version>/test-kits/` ma / planuje storyboard sprawdzający że pełna suite uruchamiana 2× przeciw temu samemu procesowi sellera daje identyczny score? To by łapało ten klasę bugów u adopters wcześnie, bez konieczności reproduction. Jeśli nie planowane — czy warto żebyśmy zaproponowali shape takiego storyboardu?

---

## Co teraz robimy (nie pytam, informuję)

- Local workaround merged into our seller branch. Pin SDK 7.11.0 zostaje.
- Czekamy na guidance B.4 (admin endpoint vs `comply_test_controller` ext scenario) przed publikacją wzorca dalej.
- Nie zgłaszamy własnego upstream PR póki #5247 nie zdecyduje Fix 1 vs Fix 2 direction — żeby nie zacementować kierunku zanim Brian to rozstrzygnie.

**— kapoost** (Purrsonality seller, `purrsonality-seller.fly.dev`)
