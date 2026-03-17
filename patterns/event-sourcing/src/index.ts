/**
 * Event Sourcing
 *
 * Instead of storing current state, store every state change as an event.
 * Current state is derived by replaying events from the beginning.
 *
 * Benefits: full audit trail, temporal queries, event replay, debugging
 * Trade-offs: eventual consistency, increased storage, complexity
 */

export interface StoredEvent {
  id: string;
  aggregateId: string;
  aggregateType: string;
  eventType: string;
  data: unknown;
  version: number;
  timestamp: Date;
  metadata?: Record<string, unknown>;
}

export interface Aggregate {
  id: string;
  version: number;
  apply(event: StoredEvent): void;
}

// === Event Store ===

export class EventStore {
  private events: StoredEvent[] = [];
  private snapshots: Map<string, { state: unknown; version: number }> = new Map();
  private subscribers: Array<(event: StoredEvent) => Promise<void>> = [];

  async append(aggregateId: string, aggregateType: string, events: Omit<StoredEvent, 'id' | 'timestamp'>[]): Promise<void> {
    // Optimistic concurrency check
    const existingEvents = this.events.filter((e) => e.aggregateId === aggregateId);
    const currentVersion = existingEvents.length > 0
      ? existingEvents[existingEvents.length - 1].version
      : 0;

    if (events.length > 0 && events[0].version !== currentVersion + 1) {
      throw new Error(
        `Concurrency conflict: expected version ${currentVersion + 1}, got ${events[0].version}`
      );
    }

    const stored = events.map((e) => ({
      ...e,
      id: `evt_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
      timestamp: new Date(),
    }));

    this.events.push(...stored);

    // Notify subscribers
    for (const event of stored) {
      for (const sub of this.subscribers) {
        await sub(event);
      }
    }
  }

  async getEvents(aggregateId: string, fromVersion?: number): Promise<StoredEvent[]> {
    return this.events
      .filter((e) => e.aggregateId === aggregateId)
      .filter((e) => fromVersion === undefined || e.version > fromVersion)
      .sort((a, b) => a.version - b.version);
  }

  async getEventsByType(eventType: string, since?: Date): Promise<StoredEvent[]> {
    return this.events
      .filter((e) => e.eventType === eventType)
      .filter((e) => !since || e.timestamp >= since);
  }

  // Snapshot for performance (avoid replaying all events)
  async saveSnapshot(aggregateId: string, state: unknown, version: number): Promise<void> {
    this.snapshots.set(aggregateId, { state, version });
  }

  async getSnapshot(aggregateId: string): Promise<{ state: unknown; version: number } | null> {
    return this.snapshots.get(aggregateId) || null;
  }

  subscribe(handler: (event: StoredEvent) => Promise<void>): void {
    this.subscribers.push(handler);
  }
}

// === Aggregate Repository ===

export class AggregateRepository<T extends Aggregate> {
  constructor(
    private eventStore: EventStore,
    private factory: () => T,
    private aggregateType: string,
    private snapshotInterval: number = 50,
  ) {}

  async load(id: string): Promise<T> {
    const aggregate = this.factory();
    (aggregate as any).id = id;

    // Try loading from snapshot first
    const snapshot = await this.eventStore.getSnapshot(id);
    if (snapshot) {
      Object.assign(aggregate, snapshot.state);
      (aggregate as any).version = snapshot.version;
    }

    // Replay events after snapshot
    const events = await this.eventStore.getEvents(id, snapshot?.version);
    for (const event of events) {
      aggregate.apply(event);
      (aggregate as any).version = event.version;
    }

    return aggregate;
  }

  async save(aggregate: T, events: Omit<StoredEvent, 'id' | 'timestamp'>[]): Promise<void> {
    await this.eventStore.append(aggregate.id, this.aggregateType, events);

    // Auto-snapshot
    const newVersion = events[events.length - 1]?.version || aggregate.version;
    if (newVersion % this.snapshotInterval === 0) {
      await this.eventStore.saveSnapshot(aggregate.id, aggregate, newVersion);
    }
  }
}

// === Example: Bank Account ===

export class BankAccount implements Aggregate {
  id = '';
  version = 0;
  balance = 0;
  owner = '';
  isOpen = false;
  transactions: Array<{ type: string; amount: number; date: Date }> = [];

  apply(event: StoredEvent): void {
    switch (event.eventType) {
      case 'AccountOpened':
        this.isOpen = true;
        this.owner = (event.data as any).owner;
        this.balance = (event.data as any).initialDeposit || 0;
        break;
      case 'MoneyDeposited':
        this.balance += (event.data as any).amount;
        this.transactions.push({
          type: 'deposit',
          amount: (event.data as any).amount,
          date: event.timestamp,
        });
        break;
      case 'MoneyWithdrawn':
        this.balance -= (event.data as any).amount;
        this.transactions.push({
          type: 'withdrawal',
          amount: (event.data as any).amount,
          date: event.timestamp,
        });
        break;
      case 'AccountClosed':
        this.isOpen = false;
        break;
    }
  }

  // Command methods that produce events (not stored yet)
  deposit(amount: number): Omit<StoredEvent, 'id' | 'timestamp'> {
    if (!this.isOpen) throw new Error('Account is closed');
    if (amount <= 0) throw new Error('Amount must be positive');

    return {
      aggregateId: this.id,
      aggregateType: 'BankAccount',
      eventType: 'MoneyDeposited',
      data: { amount },
      version: this.version + 1,
    };
  }

  withdraw(amount: number): Omit<StoredEvent, 'id' | 'timestamp'> {
    if (!this.isOpen) throw new Error('Account is closed');
    if (amount <= 0) throw new Error('Amount must be positive');
    if (this.balance < amount) throw new Error('Insufficient funds');

    return {
      aggregateId: this.id,
      aggregateType: 'BankAccount',
      eventType: 'MoneyWithdrawn',
      data: { amount },
      version: this.version + 1,
    };
  }
}
