# OpenSIN-Neural-Bus Boundaries

## Role
`OpenSIN-Neural-Bus` is the event fabric and durable messaging layer for OpenSIN runtimes and agents.

Short version:

- **This repo = event bus and durable event contracts**
- **Not this repo = sole owner of control-plane operations, memory canon, or full runtime canon**

---

## Canonical Ownership

| Concern | Canonical Repo |
|---|---|
| Event fabric / durable bus layer | `OpenSIN-Neural-Bus` |
| Free/open runtime core | `OpenSIN` |
| Internal ops control plane | `ai-agent-system` |
| Product web app | `OpenSIN-WebApp` |
| Persistent memory / PCPM | `global-brain` |
| Official documentation | `OpenSIN-documentation` |

---

## Hard rules

### 1. Bus layer, not control-plane monopoly
This repo may own event contracts, transport behavior, and durable delivery patterns. It must not become the sole owner of operational dashboards, approvals, or session/task governance.

### 2. Bus layer, not memory canon
This repo may bridge into memory systems, but it must not redefine the canonical memory authority.

### 3. Bus layer, not runtime monopoly
This repo may support runtimes and agents, but it must not imply it alone owns the whole runtime stack.
