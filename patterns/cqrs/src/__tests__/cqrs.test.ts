import {
  CommandBus,
  QueryBus,
  EventBus,
  createOrderCommandHandler,
  orderSummaryProjection,
  type Command,
  type DomainEvent,
  type OrderSummary,
} from '../index';

describe('CQRS Pattern', () => {
  // === EventBus ===

  describe('EventBus', () => {
    let eventBus: EventBus;

    beforeEach(() => {
      eventBus = new EventBus();
    });

    it('should deliver events to subscribed handlers', async () => {
      const received: DomainEvent[] = [];
      eventBus.subscribe('TestEvent', async (event) => {
        received.push(event);
      });

      const event: DomainEvent = {
        type: 'TestEvent',
        aggregateId: 'agg-1',
        data: { foo: 'bar' },
        metadata: { timestamp: Date.now(), version: 1, correlationId: 'corr-1' },
      };

      await eventBus.publish(event);
      expect(received).toHaveLength(1);
      expect(received[0]).toBe(event);
    });

    it('should support multiple subscribers for the same event type', async () => {
      let count = 0;
      eventBus.subscribe('TestEvent', async () => { count++; });
      eventBus.subscribe('TestEvent', async () => { count++; });

      await eventBus.publish({
        type: 'TestEvent',
        aggregateId: 'a',
        data: {},
        metadata: { timestamp: 0, version: 1, correlationId: 'c' },
      });

      expect(count).toBe(2);
    });

    it('should not deliver events to handlers subscribed to different types', async () => {
      const received: string[] = [];
      eventBus.subscribe('TypeA', async () => { received.push('A'); });
      eventBus.subscribe('TypeB', async () => { received.push('B'); });

      await eventBus.publish({
        type: 'TypeA',
        aggregateId: 'a',
        data: {},
        metadata: { timestamp: 0, version: 1, correlationId: 'c' },
      });

      expect(received).toEqual(['A']);
    });

    it('should handle publishing events with no subscribers gracefully', async () => {
      await expect(
        eventBus.publish({
          type: 'NoOneListens',
          aggregateId: 'a',
          data: {},
          metadata: { timestamp: 0, version: 1, correlationId: 'c' },
        })
      ).resolves.toBeUndefined();
    });
  });

  // === CommandBus ===

  describe('CommandBus', () => {
    let eventBus: EventBus;
    let commandBus: CommandBus;

    beforeEach(() => {
      eventBus = new EventBus();
      commandBus = new CommandBus(eventBus);
    });

    it('should dispatch a command to its registered handler', async () => {
      commandBus.register('DoSomething', async (cmd) => ({
        success: true,
        events: [{
          type: 'SomethingDone',
          aggregateId: 'agg-1',
          data: cmd.payload,
          metadata: { timestamp: Date.now(), version: 1, correlationId: cmd.metadata.correlationId },
        }],
      }));

      const result = await commandBus.dispatch({
        type: 'DoSomething',
        payload: { value: 42 },
        metadata: { userId: 'user-1', timestamp: Date.now(), correlationId: 'corr-1' },
      });

      expect(result.success).toBe(true);
      expect(result.events).toHaveLength(1);
      expect(result.events[0].type).toBe('SomethingDone');
    });

    it('should return an error when no handler is registered', async () => {
      const result = await commandBus.dispatch({
        type: 'UnknownCommand',
        payload: {},
        metadata: { userId: 'u', timestamp: 0, correlationId: 'c' },
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('No handler for command: UnknownCommand');
      expect(result.events).toEqual([]);
    });

    it('should publish events to the EventBus on success', async () => {
      const publishedEvents: DomainEvent[] = [];
      eventBus.subscribe('ItemCreated', async (e) => { publishedEvents.push(e); });

      commandBus.register('CreateItem', async () => ({
        success: true,
        events: [{
          type: 'ItemCreated',
          aggregateId: 'item-1',
          data: { name: 'Widget' },
          metadata: { timestamp: Date.now(), version: 1, correlationId: 'c' },
        }],
      }));

      await commandBus.dispatch({
        type: 'CreateItem',
        payload: {},
        metadata: { userId: 'u', timestamp: 0, correlationId: 'c' },
      });

      expect(publishedEvents).toHaveLength(1);
      expect(publishedEvents[0].type).toBe('ItemCreated');
    });

    it('should NOT publish events when the command handler returns failure', async () => {
      const publishedEvents: DomainEvent[] = [];
      eventBus.subscribe('ShouldNotSee', async (e) => { publishedEvents.push(e); });

      commandBus.register('FailingCommand', async () => ({
        success: false,
        events: [{
          type: 'ShouldNotSee',
          aggregateId: 'a',
          data: {},
          metadata: { timestamp: 0, version: 1, correlationId: 'c' },
        }],
        error: 'Validation failed',
      }));

      const result = await commandBus.dispatch({
        type: 'FailingCommand',
        payload: {},
        metadata: { userId: 'u', timestamp: 0, correlationId: 'c' },
      });

      expect(result.success).toBe(false);
      expect(publishedEvents).toHaveLength(0);
    });
  });

  // === QueryBus ===

  describe('QueryBus', () => {
    let queryBus: QueryBus;

    beforeEach(() => {
      queryBus = new QueryBus();
    });

    it('should execute a registered query handler and return the result', async () => {
      queryBus.register('GetUser', async (query) => ({
        id: query.params.userId,
        name: 'Alice',
      }));

      const result = await queryBus.execute<{ id: unknown; name: string }>({
        type: 'GetUser',
        params: { userId: 'user-1' },
      });

      expect(result.name).toBe('Alice');
      expect(result.id).toBe('user-1');
    });

    it('should throw when no handler is registered for a query', async () => {
      await expect(
        queryBus.execute({ type: 'NonExistent', params: {} })
      ).rejects.toThrow('No handler for query: NonExistent');
    });
  });

  // === Order Domain Integration ===

  describe('Order Domain (end-to-end)', () => {
    it('should create an order and project it into the read model', async () => {
      const eventBus = new EventBus();
      const commandBus = new CommandBus(eventBus);
      const queryBus = new QueryBus();

      const orderStore = new Map();
      const readStore = new Map<string, OrderSummary[]>();

      // Wire up command handler
      commandBus.register('CreateOrder', createOrderCommandHandler(orderStore));

      // Wire up projection
      eventBus.subscribe('OrderCreated', orderSummaryProjection(readStore));

      // Wire up query handler
      queryBus.register('GetUserOrders', async (query) => {
        return readStore.get(query.params.userId as string) || [];
      });

      // Dispatch a CreateOrder command
      const result = await commandBus.dispatch({
        type: 'CreateOrder',
        payload: {
          userId: 'user-42',
          items: [
            { productId: 'prod-1', quantity: 2, price: 10 },
            { productId: 'prod-2', quantity: 1, price: 25 },
          ],
        },
        metadata: { userId: 'user-42', timestamp: Date.now(), correlationId: 'corr-order-1' },
      });

      expect(result.success).toBe(true);
      expect(result.events).toHaveLength(1);
      expect(result.events[0].type).toBe('OrderCreated');

      // Verify write model
      expect(orderStore.size).toBe(1);
      const writtenOrder = [...orderStore.values()][0];
      expect(writtenOrder.total).toBe(45); // 2*10 + 1*25
      expect(writtenOrder.status).toBe('pending');

      // Verify read model (projection)
      const userOrders = await queryBus.execute<OrderSummary[]>({
        type: 'GetUserOrders',
        params: { userId: 'user-42' },
      });

      expect(userOrders).toHaveLength(1);
      expect(userOrders[0].total).toBe(45);
      expect(userOrders[0].itemCount).toBe(2);
      expect(userOrders[0].status).toBe('pending');
    });

    it('should accumulate multiple orders for the same user in the read model', async () => {
      const eventBus = new EventBus();
      const commandBus = new CommandBus(eventBus);
      const readStore = new Map<string, OrderSummary[]>();

      commandBus.register('CreateOrder', createOrderCommandHandler(new Map()));
      eventBus.subscribe('OrderCreated', orderSummaryProjection(readStore));

      for (let i = 0; i < 3; i++) {
        await commandBus.dispatch({
          type: 'CreateOrder',
          payload: {
            userId: 'user-1',
            items: [{ productId: `p-${i}`, quantity: 1, price: 10 }],
          },
          metadata: { userId: 'user-1', timestamp: Date.now(), correlationId: `c-${i}` },
        });
      }

      const summaries = readStore.get('user-1');
      expect(summaries).toHaveLength(3);
    });
  });
});
