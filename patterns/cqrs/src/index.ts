/**
 * CQRS - Command Query Responsibility Segregation
 *
 * Separates read and write models:
 * - Commands: modify state, validate business rules, emit events
 * - Queries: read optimized projections, no side effects
 * - Projections: event handlers that build read models
 *
 * This pattern shines when read and write models have different shapes,
 * or when you need to scale reads and writes independently.
 */

// === Command Side ===

interface Command {
  type: string;
  payload: unknown;
  metadata: { userId: string; timestamp: number; correlationId: string };
}

interface CommandResult {
  success: boolean;
  events: DomainEvent[];
  error?: string;
}

interface DomainEvent {
  type: string;
  aggregateId: string;
  data: unknown;
  metadata: { timestamp: number; version: number; correlationId: string };
}

type CommandHandler<T extends Command = Command> = (cmd: T) => Promise<CommandResult>;
type EventHandler = (event: DomainEvent) => Promise<void>;

export class CommandBus {
  private handlers = new Map<string, CommandHandler>();
  private eventBus: EventBus;

  constructor(eventBus: EventBus) {
    this.eventBus = eventBus;
  }

  register<T extends Command>(commandType: string, handler: CommandHandler<T>): void {
    this.handlers.set(commandType, handler as CommandHandler);
  }

  getRegisteredCommands(): string[] {
    return Array.from(this.handlers.keys());
  }

  async dispatch(command: Command): Promise<CommandResult> {
    const handler = this.handlers.get(command.type);
    if (!handler) {
      return { success: false, events: [], error: `No handler for command: ${command.type}` };
    }

    const result = await handler(command);

    // Publish events from successful commands
    if (result.success) {
      for (const event of result.events) {
        await this.eventBus.publish(event);
      }
    }

    return result;
  }
}

// === Query Side ===

interface Query {
  type: string;
  params: Record<string, unknown>;
}

type QueryHandler<TResult = unknown> = (query: Query) => Promise<TResult>;

export class QueryBus {
  private handlers = new Map<string, QueryHandler>();

  register<TResult>(queryType: string, handler: QueryHandler<TResult>): void {
    this.handlers.set(queryType, handler as QueryHandler);
  }

  async execute<TResult>(query: Query): Promise<TResult> {
    const handler = this.handlers.get(query.type);
    if (!handler) {
      throw new Error(`No handler for query: ${query.type}`);
    }
    return handler(query) as Promise<TResult>;
  }
}

// === Event Bus & Projections ===

export class EventBus {
  private handlers = new Map<string, EventHandler[]>();

  subscribe(eventType: string, handler: EventHandler): void {
    const existing = this.handlers.get(eventType) || [];
    existing.push(handler);
    this.handlers.set(eventType, existing);
  }

  async publish(event: DomainEvent): Promise<void> {
    const handlers = this.handlers.get(event.type) || [];
    await Promise.all(handlers.map((h) => h(event)));
  }

  unsubscribe(eventType: string, handler: EventHandler): void {
    const existing = this.handlers.get(eventType);
    if (!existing) return;
    this.handlers.set(eventType, existing.filter((h) => h !== handler));
  }
}

// === Example: Order Domain ===

interface OrderState {
  id: string;
  status: string;
  items: Array<{ productId: string; quantity: number; price: number }>;
  total: number;
  userId: string;
}

// Write model (command handler)
export function createOrderCommandHandler(
  orderStore: Map<string, OrderState>
): CommandHandler {
  return async (cmd) => {
    const { userId, items } = cmd.payload as any;
    const orderId = `order_${Date.now()}`;

    const total = items.reduce((sum: number, i: any) => sum + i.price * i.quantity, 0);

    const order: OrderState = { id: orderId, status: 'pending', items, total, userId };
    orderStore.set(orderId, order);

    return {
      success: true,
      events: [{
        type: 'OrderCreated',
        aggregateId: orderId,
        data: { orderId, userId, items, total },
        metadata: {
          timestamp: Date.now(),
          version: 1,
          correlationId: cmd.metadata.correlationId,
        },
      }],
    };
  };
}

// Read model (projection) — optimized for listing user orders
export interface OrderSummary {
  orderId: string;
  total: number;
  status: string;
  itemCount: number;
  createdAt: number;
}

export function orderSummaryProjection(
  readStore: Map<string, OrderSummary[]>
): EventHandler {
  return async (event) => {
    if (event.type !== 'OrderCreated') return;

    const { orderId, userId, items, total } = event.data as any;

    const summaries = readStore.get(userId) || [];
    summaries.push({
      orderId,
      total,
      status: 'pending',
      itemCount: items.length,
      createdAt: event.metadata.timestamp,
    });
    readStore.set(userId, summaries);
  };
}

export type { Command, CommandResult, DomainEvent, Query };
