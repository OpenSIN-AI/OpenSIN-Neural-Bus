# Contributing

## Boundary Rules

Before adding an event contract, bridge, or top-level claim, answer:

1. Is this bus-layer behavior, or is it drifting into control-plane or memory ownership?
2. Does another OpenSIN repo already own the canonical source of truth?

### Put it in `OpenSIN-Neural-Bus` if:
- it improves event transport, durable delivery, subject taxonomy, or event envelopes
- it clarifies bus-layer integration behavior

### Do NOT put it in `OpenSIN-Neural-Bus` if:
- it claims control-plane ownership
- it claims memory canon ownership
- it implies this repo alone owns the full runtime stack
