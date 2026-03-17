import {
  EventStore,
  AggregateRepository,
  BankAccount,
  type StoredEvent,
} from '../index';

describe('Event Sourcing Pattern', () => {
  // === EventStore ===

  describe('EventStore', () => {
    let store: EventStore;

    beforeEach(() => {
      store = new EventStore();
    });

    it('should append and retrieve events for an aggregate', async () => {
      await store.append('acc-1', 'BankAccount', [
        { aggregateId: 'acc-1', aggregateType: 'BankAccount', eventType: 'AccountOpened', data: { owner: 'Alice' }, version: 1 },
      ]);

      const events = await store.getEvents('acc-1');
      expect(events).toHaveLength(1);
      expect(events[0].eventType).toBe('AccountOpened');
      expect(events[0].id).toBeDefined();
      expect(events[0].timestamp).toBeInstanceOf(Date);
    });

    it('should append multiple events in a single call', async () => {
      await store.append('acc-1', 'BankAccount', [
        { aggregateId: 'acc-1', aggregateType: 'BankAccount', eventType: 'AccountOpened', data: { owner: 'Alice' }, version: 1 },
        { aggregateId: 'acc-1', aggregateType: 'BankAccount', eventType: 'MoneyDeposited', data: { amount: 100 }, version: 2 },
      ]);

      const events = await store.getEvents('acc-1');
      expect(events).toHaveLength(2);
      expect(events[0].version).toBe(1);
      expect(events[1].version).toBe(2);
    });

    it('should enforce optimistic concurrency on version mismatch', async () => {
      await store.append('acc-1', 'BankAccount', [
        { aggregateId: 'acc-1', aggregateType: 'BankAccount', eventType: 'AccountOpened', data: {}, version: 1 },
      ]);

      await expect(
        store.append('acc-1', 'BankAccount', [
          { aggregateId: 'acc-1', aggregateType: 'BankAccount', eventType: 'MoneyDeposited', data: { amount: 50 }, version: 1 },
        ])
      ).rejects.toThrow('Concurrency conflict: expected version 2, got 1');
    });

    it('should return events filtered by fromVersion', async () => {
      await store.append('acc-1', 'BankAccount', [
        { aggregateId: 'acc-1', aggregateType: 'BankAccount', eventType: 'AccountOpened', data: {}, version: 1 },
        { aggregateId: 'acc-1', aggregateType: 'BankAccount', eventType: 'MoneyDeposited', data: { amount: 50 }, version: 2 },
        { aggregateId: 'acc-1', aggregateType: 'BankAccount', eventType: 'MoneyDeposited', data: { amount: 30 }, version: 3 },
      ]);

      const events = await store.getEvents('acc-1', 1);
      expect(events).toHaveLength(2);
      expect(events[0].version).toBe(2);
      expect(events[1].version).toBe(3);
    });

    it('should return events filtered by event type', async () => {
      await store.append('acc-1', 'BankAccount', [
        { aggregateId: 'acc-1', aggregateType: 'BankAccount', eventType: 'AccountOpened', data: {}, version: 1 },
        { aggregateId: 'acc-1', aggregateType: 'BankAccount', eventType: 'MoneyDeposited', data: { amount: 100 }, version: 2 },
      ]);

      const deposits = await store.getEventsByType('MoneyDeposited');
      expect(deposits).toHaveLength(1);
      expect(deposits[0].eventType).toBe('MoneyDeposited');
    });

    it('should isolate events between different aggregates', async () => {
      await store.append('acc-1', 'BankAccount', [
        { aggregateId: 'acc-1', aggregateType: 'BankAccount', eventType: 'AccountOpened', data: {}, version: 1 },
      ]);
      await store.append('acc-2', 'BankAccount', [
        { aggregateId: 'acc-2', aggregateType: 'BankAccount', eventType: 'AccountOpened', data: {}, version: 1 },
      ]);

      const events1 = await store.getEvents('acc-1');
      const events2 = await store.getEvents('acc-2');
      expect(events1).toHaveLength(1);
      expect(events2).toHaveLength(1);
    });

    it('should notify subscribers when events are appended', async () => {
      const received: StoredEvent[] = [];
      store.subscribe(async (event) => { received.push(event); });

      await store.append('acc-1', 'BankAccount', [
        { aggregateId: 'acc-1', aggregateType: 'BankAccount', eventType: 'AccountOpened', data: {}, version: 1 },
      ]);

      expect(received).toHaveLength(1);
      expect(received[0].eventType).toBe('AccountOpened');
    });

    // Snapshots
    it('should save and retrieve snapshots', async () => {
      await store.saveSnapshot('acc-1', { balance: 500, owner: 'Alice' }, 10);

      const snapshot = await store.getSnapshot('acc-1');
      expect(snapshot).not.toBeNull();
      expect(snapshot!.version).toBe(10);
      expect((snapshot!.state as any).balance).toBe(500);
    });

    it('should return null for a non-existent snapshot', async () => {
      const snapshot = await store.getSnapshot('does-not-exist');
      expect(snapshot).toBeNull();
    });
  });

  // === BankAccount Aggregate ===

  describe('BankAccount', () => {
    let account: BankAccount;

    beforeEach(() => {
      account = new BankAccount();
      account.id = 'acc-1';
      // Open the account by applying an event
      account.apply({
        id: 'e1',
        aggregateId: 'acc-1',
        aggregateType: 'BankAccount',
        eventType: 'AccountOpened',
        data: { owner: 'Alice', initialDeposit: 100 },
        version: 1,
        timestamp: new Date(),
      });
      account.version = 1;
    });

    it('should apply AccountOpened event correctly', () => {
      expect(account.isOpen).toBe(true);
      expect(account.owner).toBe('Alice');
      expect(account.balance).toBe(100);
    });

    it('should produce a deposit event and apply it to increase balance', () => {
      const event = account.deposit(50);
      expect(event.eventType).toBe('MoneyDeposited');
      expect(event.version).toBe(2);

      // Apply the event to mutate state
      account.apply({ ...event, id: 'e2', timestamp: new Date() } as StoredEvent);
      account.version = 2;
      expect(account.balance).toBe(150);
      expect(account.transactions).toHaveLength(1);
      expect(account.transactions[0].type).toBe('deposit');
    });

    it('should produce a withdrawal event and apply it to decrease balance', () => {
      const event = account.withdraw(30);
      expect(event.eventType).toBe('MoneyWithdrawn');

      account.apply({ ...event, id: 'e2', timestamp: new Date() } as StoredEvent);
      expect(account.balance).toBe(70);
    });

    it('should throw on withdrawal exceeding balance', () => {
      expect(() => account.withdraw(200)).toThrow('Insufficient funds');
    });

    it('should throw on deposit of non-positive amount', () => {
      expect(() => account.deposit(0)).toThrow('Amount must be positive');
      expect(() => account.deposit(-5)).toThrow('Amount must be positive');
    });

    it('should throw on withdraw of non-positive amount', () => {
      expect(() => account.withdraw(0)).toThrow('Amount must be positive');
    });

    it('should throw deposit/withdraw on a closed account', () => {
      account.apply({
        id: 'e-close',
        aggregateId: 'acc-1',
        aggregateType: 'BankAccount',
        eventType: 'AccountClosed',
        data: {},
        version: 2,
        timestamp: new Date(),
      });

      expect(account.isOpen).toBe(false);
      expect(() => account.deposit(10)).toThrow('Account is closed');
      expect(() => account.withdraw(10)).toThrow('Account is closed');
    });
  });

  // === AggregateRepository ===

  describe('AggregateRepository', () => {
    let store: EventStore;
    let repo: AggregateRepository<BankAccount>;

    beforeEach(() => {
      store = new EventStore();
      repo = new AggregateRepository(store, () => new BankAccount(), 'BankAccount', 5);
    });

    it('should load an aggregate by replaying its events', async () => {
      await store.append('acc-1', 'BankAccount', [
        { aggregateId: 'acc-1', aggregateType: 'BankAccount', eventType: 'AccountOpened', data: { owner: 'Bob', initialDeposit: 200 }, version: 1 },
        { aggregateId: 'acc-1', aggregateType: 'BankAccount', eventType: 'MoneyDeposited', data: { amount: 50 }, version: 2 },
        { aggregateId: 'acc-1', aggregateType: 'BankAccount', eventType: 'MoneyWithdrawn', data: { amount: 30 }, version: 3 },
      ]);

      const account = await repo.load('acc-1');
      expect(account.owner).toBe('Bob');
      expect(account.balance).toBe(220); // 200 + 50 - 30
      expect(account.version).toBe(3);
      expect(account.isOpen).toBe(true);
      expect(account.transactions).toHaveLength(2);
    });

    it('should save events and auto-snapshot at the configured interval', async () => {
      // Open the account (version 1)
      await store.append('acc-1', 'BankAccount', [
        { aggregateId: 'acc-1', aggregateType: 'BankAccount', eventType: 'AccountOpened', data: { owner: 'Eve', initialDeposit: 0 }, version: 1 },
      ]);

      // Add deposits to reach version 5 (snapshot interval)
      const events = [];
      for (let v = 2; v <= 5; v++) {
        events.push({
          aggregateId: 'acc-1',
          aggregateType: 'BankAccount',
          eventType: 'MoneyDeposited',
          data: { amount: 10 },
          version: v,
        });
      }

      const account = await repo.load('acc-1');
      await repo.save(account, events);

      // Snapshot should have been saved at version 5
      const snapshot = await store.getSnapshot('acc-1');
      expect(snapshot).not.toBeNull();
      expect(snapshot!.version).toBe(5);
    });

    it('should load from snapshot and replay only newer events', async () => {
      // Seed events
      await store.append('acc-1', 'BankAccount', [
        { aggregateId: 'acc-1', aggregateType: 'BankAccount', eventType: 'AccountOpened', data: { owner: 'Carol', initialDeposit: 100 }, version: 1 },
        { aggregateId: 'acc-1', aggregateType: 'BankAccount', eventType: 'MoneyDeposited', data: { amount: 50 }, version: 2 },
      ]);

      // Manually save a snapshot at version 2
      await store.saveSnapshot('acc-1', {
        id: 'acc-1',
        version: 2,
        balance: 150,
        owner: 'Carol',
        isOpen: true,
        transactions: [],
      }, 2);

      // Add more events after snapshot
      await store.append('acc-1', 'BankAccount', [
        { aggregateId: 'acc-1', aggregateType: 'BankAccount', eventType: 'MoneyWithdrawn', data: { amount: 25 }, version: 3 },
      ]);

      const account = await repo.load('acc-1');
      expect(account.balance).toBe(125); // 150 (from snapshot) - 25
      expect(account.version).toBe(3);
      expect(account.owner).toBe('Carol');
    });
  });
});
