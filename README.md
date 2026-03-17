# System Design Patterns

![TypeScript](https://img.shields.io/badge/TypeScript-5.0-blue?style=flat-square&logo=typescript)
![Patterns](https://img.shields.io/badge/Patterns-6-green?style=flat-square)

Production-ready implementations of distributed system design patterns. Each pattern includes working code, documentation, and usage examples.

## Patterns

| Pattern | Description | Use Case |
|---------|-------------|----------|
| [CQRS](patterns/cqrs/) | Command Query Responsibility Segregation | Separate read/write models for complex domains |
| [Event Sourcing](patterns/event-sourcing/) | Store state as sequence of events | Audit trails, temporal queries, replay |
| [Saga Orchestrator](patterns/saga-orchestrator/) | Distributed transaction coordination | Multi-service business processes |
| [API Versioning](patterns/api-versioning/) | Header/URL/content-type versioning | Breaking changes without breaking clients |
| [Distributed Cache](patterns/distributed-cache/) | Multi-tier caching with invalidation | High-read, low-write workloads |
| [Rate Limiting](patterns/rate-limiting/) | Token bucket + sliding window algorithms | API protection, fair usage |

## Architecture Principles

1. **Eventual Consistency** — Accept that distributed systems can't be strongly consistent everywhere. Design for it.
2. **Idempotency** — Every operation should be safe to retry. Use idempotency keys.
3. **Circuit Breakers** — Fail fast when dependencies are unhealthy.
4. **Observability First** — If you can't measure it, you can't manage it.
5. **Design for Failure** — Everything fails. Handle it gracefully.

## License

MIT
